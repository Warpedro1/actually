"use client";

import type { Alert, Evidence, Verification } from "@actually/db";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VERDICT_LABEL } from "@/lib/feed";
import { formatDuration, formatTimeSec, secondsSince } from "@/lib/format";
import { retractAlert } from "@/lib/staff/retract";
import { DebatePicker } from "./DebatePicker";
import { SpeakerMapPanel } from "./SpeakerMapPanel";
import { Button, Card, ErrorText, Field, inputCls, OkText, Pill, errMsg } from "./ui";
import { useDebates, useNow, useTableChanges } from "./useStaffData";

type PendingAlert = Alert & {
  verification: (Pick<Verification, "verdict" | "model_confidence" | "final_score" | "score_components" | "layer"> & {
    evidence: Pick<Evidence, "id" | "url" | "source_name" | "source_tier" | "quote" | "quote_verified" | "evidence_type">[];
  }) | null;
  claim: { segment_id: number; text_original: string } | null;
};

// Dica explícita de FK: alerts→verifications e alerts→claims têm caminhos alternativos.
const PENDING_SELECT =
  "*, verification:verifications!alerts_verification_id_fkey(verdict, model_confidence, final_score, score_components, layer, evidence(id, url, source_name, source_tier, quote, quote_verified, evidence_type)), claim:claims!alerts_claim_id_fkey(segment_id, text_original)";

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export function EditorApp({ client, user }: { client: SupabaseClient; user: User }) {
  const { debates, selected, select, error: debatesErr } = useDebates(client);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Fila de revisão</h1>
        <DebatePicker debates={debates} selected={selected} onSelect={select} />
      </div>
      <ErrorText>{debatesErr}</ErrorText>
      {selected ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <ReviewQueue client={client} user={user} debateId={selected.id} />
            <PublishedList client={client} user={user} debateId={selected.id} />
          </div>
          <SpeakerMapPanel client={client} user={user} debateId={selected.id} />
        </div>
      ) : null}
    </div>
  );
}

function ReviewQueue({ client, user, debateId }: { client: SupabaseClient; user: User; debateId: string }) {
  const [items, setItems] = useState<PendingAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const now = useNow(1000);

  const load = useCallback(async () => {
    const { data, error: err } = await client
      .from("alerts")
      .select(PENDING_SELECT)
      .eq("debate_id", debateId)
      .eq("status", "pending_review")
      .order("created_at", { ascending: true });
    if (err) return setError(`Falha ao carregar a fila: ${errMsg(err)}`);
    setError(null);
    setItems((data ?? []) as PendingAlert[]);
  }, [client, debateId]);

  useEffect(() => {
    setItems(null);
    void load();
    const id = setInterval(() => void load(), 10_000); // rede de segurança se o Realtime cair
    return () => clearInterval(id);
  }, [load]);

  const rt = useTableChanges(client, "alerts", `debate_id=eq.${debateId}`, load);

  const count = items?.length ?? 0;
  useEffect(() => {
    if (cursor >= count) setCursor(Math.max(0, count - 1));
  }, [count, cursor]);

  // j/k ou setas navegam; A/R/E agem no item selecionado (tratados no item).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        setCursor((c) => Math.min(c + 1, Math.max(0, count - 1)));
        e.preventDefault();
      } else if (e.key === "k" || e.key === "ArrowUp") {
        setCursor((c) => Math.max(c - 1, 0));
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count]);

  return (
    <Card
      title={
        <>
          Pendentes{" "}
          <span className="ml-1 rounded-full bg-fg px-2 py-0.5 text-xs text-bg" aria-label={`${count} pendentes`}>
            {count}
          </span>
        </>
      }
      actions={
        <span className="text-xs text-muted">
          {rt === "live" ? "Tempo real" : rt === "down" ? "Realtime fora — atualizando a cada 10 s" : "Conectando…"} ·
          Atalhos: <kbd>J</kbd>/<kbd>K</kbd> navegar, <kbd>A</kbd> aprovar, <kbd>R</kbd> rejeitar, <kbd>E</kbd> editar
        </span>
      }
    >
      <ErrorText>{error}</ErrorText>
      {items === null ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
          Nada pendente. Alertas que exigem revisão aparecem aqui na hora.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {items.map((a, i) => (
            <li key={a.id}>
              <ReviewItem
                client={client}
                user={user}
                alert={a}
                active={i === cursor}
                onFocus={() => setCursor(i)}
                now={now}
                onDone={load}
              />
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function ReviewItem({
  client,
  user,
  alert,
  active,
  onFocus,
  now,
  onDone,
}: {
  client: SupabaseClient;
  user: User;
  alert: PendingAlert;
  active: boolean;
  onFocus: () => void;
  now: number;
  onDone: () => Promise<void> | void;
}) {
  const [mode, setMode] = useState<"view" | "reject" | "edit">("view");
  const [reason, setReason] = useState("");
  const [summary, setSummary] = useState(alert.summary);
  const [correction, setCorrection] = useState(alert.correction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const waited = secondsSince(alert.created_at, now) ?? 0;
  const v = alert.verification;
  const evidence = v?.evidence ?? [];
  const hasVerified = evidence.some((e) => e.quote_verified);
  const label = VERDICT_LABEL[alert.verdict];

  const review = useCallback(
    async (patch: Partial<Alert>, success: string) => {
      setBusy(true);
      setError(null);
      const { data, error: err } = await client
        .from("alerts")
        .update({ ...patch, reviewed_by: user.id, reviewed_at: new Date().toISOString() })
        .eq("id", alert.id)
        .eq("status", "pending_review")
        .select("id");
      setBusy(false);
      if (err) return setError(`O banco recusou: ${errMsg(err)}`);
      if (!data?.length) return setError("Este alerta já foi revisado por outra pessoa.");
      setOk(success);
      await onDone();
    },
    [client, user.id, alert.id, onDone],
  );

  const approve = useCallback(() => void review({ status: "published" }, "Publicado."), [review]);

  async function saveEdit() {
    setBusy(true);
    setError(null);
    const { error: err } = await client
      .from("alerts")
      .update({ summary: summary.trim(), correction: correction.trim() })
      .eq("id", alert.id);
    setBusy(false);
    if (err) return setError(errMsg(err));
    setMode("view");
    setOk("Texto atualizado.");
    await onDone();
  }

  useEffect(() => {
    if (!active) return;
    ref.current?.scrollIntoView({ block: "nearest" });
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey || busy) return;
      const k = e.key.toLowerCase();
      if (k === "a" && mode === "view") {
        e.preventDefault();
        approve();
      } else if (k === "r" && mode === "view") {
        e.preventDefault();
        setMode("reject");
        setTimeout(() => reasonRef.current?.focus(), 0);
      } else if (k === "e" && mode === "view") {
        e.preventDefault();
        setMode("edit");
        setTimeout(() => editRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, mode, busy, approve]);

  const urgency = waited > 60 ? "bad" : waited > 20 ? "warn" : "neutral";

  return (
    <article
      ref={ref}
      tabIndex={-1}
      onFocus={onFocus}
      onClick={onFocus}
      aria-current={active ? "true" : undefined}
      className={`rounded-xl border p-4 ${active ? "border-focus ring-2 ring-focus/40" : "border-border"} bg-bg`}
      onKeyDown={(e) => {
        if (e.key === "Escape") setMode("view");
      }}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Pill tone={alert.verdict === "contradito" ? "bad" : "warn"}>
          {label.icon} {label.text}
        </Pill>
        <Pill tone={urgency}>esperando {formatDuration(waited)}</Pill>
        {alert.is_repeat ? <Pill>repetição</Pill> : null}
        {alert.verification?.score_components?.review_band ? (
          <Pill tone="warn">abaixo do limiar: só sai se você aprovar</Pill>
        ) : null}
        <span className="ml-auto text-xs text-muted">
          {alert.speaker_label ? `speaker ${alert.speaker_label} · ` : ""}
          {formatTimeSec(alert.created_at)}
        </span>
      </header>

      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Afirmação</p>
      <p className="text-base">“{alert.claim_text}”</p>

      {mode === "edit" ? (
        <div className="mt-3 flex flex-col gap-2">
          <Field label="Correção (1 linha com o dado correto)" htmlFor={`corr-${alert.id}`}>
            <textarea
              id={`corr-${alert.id}`}
              ref={editRef}
              rows={2}
              value={correction}
              onChange={(e) => setCorrection(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Resumo" htmlFor={`sum-${alert.id}`}>
            <textarea id={`sum-${alert.id}`} rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} className={inputCls} />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => void saveEdit()} disabled={busy || !correction.trim() || !summary.trim()}>
              Salvar texto
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>
              Cancelar (Esc)
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">Correção</p>
          <p className="text-base font-semibold">{alert.correction}</p>
          {alert.summary && alert.summary !== alert.correction ? <p className="text-sm text-muted">{alert.summary}</p> : null}
        </>
      )}

      {v ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-surface-2 p-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted">Score final</dt>
            <dd className="text-base font-semibold tabular-nums">{v.final_score.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-muted">Confiança do modelo</dt>
            <dd className="tabular-nums">{v.model_confidence.toFixed(2)}</dd>
          </div>
          <div>
            <dt className="text-muted">Camada</dt>
            <dd>{v.layer}</dd>
          </div>
          <div>
            <dt className="text-muted">Veredito</dt>
            <dd>{v.verdict}</dd>
          </div>
          {Object.entries(v.score_components ?? {}).map(([k, val]) => (
            <div key={k}>
              <dt className="text-muted">{k}</dt>
              <dd className="tabular-nums">{typeof val === "number" ? val.toFixed(2) : String(val)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-3 flex flex-col gap-2">
        {evidence.length === 0 ? <ErrorText>Sem evidência — não pode ser publicado.</ErrorText> : null}
        {evidence.map((e) => (
          <div key={e.id} className="rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {e.quote_verified ? <Pill tone="ok">✓ citação verificada</Pill> : <Pill tone="bad">✗ citação NÃO verificada</Pill>}
              <Pill>tier {e.source_tier}</Pill>
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                {e.source_name}
              </a>
            </div>
            <blockquote className="mt-1.5 border-l-2 border-border pl-2 italic">“{e.quote}”</blockquote>
          </div>
        ))}
      </div>

      {alert.claim ? <TranscriptContext client={client} segmentId={alert.claim.segment_id} debateId={alert.debate_id} /> : null}

      <div className="mt-3 flex flex-col gap-2">
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
        {mode === "reject" ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void review({ status: "rejected", reject_reason: reason.trim() }, "Rejeitado.");
            }}
          >
            <input
              ref={reasonRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Motivo da rejeição (obrigatório)"
              aria-label="Motivo da rejeição"
              className={inputCls}
              required
            />
            <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
              Confirmar rejeição
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>
              Cancelar
            </Button>
          </form>
        ) : mode === "view" ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={approve} disabled={busy} title={hasVerified ? "" : "Sem citação verificada: o banco vai recusar"}>
              Aprovar (A)
            </Button>
            <Button variant="danger" onClick={() => setMode("reject")} disabled={busy}>
              Rejeitar (R)
            </Button>
            <Button onClick={() => setMode("edit")} disabled={busy}>
              Editar (E)
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

type PublishedAlert = Pick<
  Alert,
  "id" | "verdict" | "claim_text" | "correction" | "is_repeat" | "repeat_of" | "speaker_label" | "created_at" | "published_at"
>;

/** Limite da lista de publicados (os mais recentes primeiro). */
const PUBLISHED_LIMIT = 100;

/**
 * Alertas no ar, com "Retirar" (revisão posterior / alerta errado publicado).
 * Retirar o original retira as repetições (trigger no banco).
 */
function PublishedList({ client, user, debateId }: { client: SupabaseClient; user: User; debateId: string }) {
  const [items, setItems] = useState<PublishedAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await client
      .from("alerts")
      .select("id, verdict, claim_text, correction, is_repeat, repeat_of, speaker_label, created_at, published_at")
      .eq("debate_id", debateId)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(PUBLISHED_LIMIT);
    if (err) return setError(`Falha ao carregar os publicados: ${errMsg(err)}`);
    setError(null);
    setItems((data ?? []) as PublishedAlert[]);
  }, [client, debateId]);

  useEffect(() => {
    setItems(null);
    setOk(null);
    void load();
    const id = setInterval(() => void load(), 10_000); // rede de segurança se o Realtime cair
    return () => clearInterval(id);
  }, [load]);

  useTableChanges(client, "alerts", `debate_id=eq.${debateId}`, load);

  const repeatsOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of items ?? []) if (a.repeat_of) m.set(a.repeat_of, (m.get(a.repeat_of) ?? 0) + 1);
    return m;
  }, [items]);

  const count = items?.length ?? 0;
  return (
    <Card
      id="publicados"
      title={
        <>
          Publicados{" "}
          <span className="ml-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg" aria-label={`${count} publicados`}>
            {count}
          </span>
        </>
      }
      actions={<span className="text-xs text-muted">Alerta errado no ar? Retire com motivo — some do /ao-vivo em segundos.</span>}
    >
      <div className="flex flex-col gap-2">
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
      </div>
      {items === null ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">Nenhum alerta no ar.</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-3">
          {items.map((a) => (
            <li key={a.id}>
              <PublishedItem
                client={client}
                user={user}
                alert={a}
                repeats={repeatsOf.get(a.id) ?? 0}
                onDone={async (msg) => {
                  setOk(msg);
                  await load();
                }}
              />
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function PublishedItem({
  client,
  user,
  alert,
  repeats,
  onDone,
}: {
  client: SupabaseClient;
  user: User;
  alert: PublishedAlert;
  repeats: number;
  onDone: (msg: string) => Promise<void> | void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const label = VERDICT_LABEL[alert.verdict];

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await retractAlert(client, { alertId: alert.id, userId: user.id, reason });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setConfirming(false);
    await onDone(
      repeats > 0 ? `Retirado, com ${repeats} repetição(ões). Publique a nota de correção.` : "Retirado. Publique a nota de correção.",
    );
  }

  return (
    <article
      className="rounded-xl border border-border bg-bg p-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") setConfirming(false);
      }}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Pill tone={alert.verdict === "contradito" ? "bad" : "warn"}>
          {label.icon} {label.text}
        </Pill>
        {alert.is_repeat ? <Pill>repetição</Pill> : null}
        {repeats > 0 ? <Pill>{repeats} repetição(ões) no ar</Pill> : null}
        <span className="ml-auto text-xs text-muted">
          {alert.speaker_label ? `speaker ${alert.speaker_label} · ` : ""}
          no ar desde {formatTimeSec(alert.published_at ?? alert.created_at)}
        </span>
      </header>
      <p className="mt-2 text-sm">“{alert.claim_text}”</p>
      <p className="text-sm font-semibold">{alert.correction}</p>

      <div className="mt-3 flex flex-col gap-2">
        <ErrorText>{error}</ErrorText>
        {confirming ? (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              ref={reasonRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Motivo da retirada (obrigatório)"
              aria-label="Motivo da retirada"
              className={inputCls}
              required
            />
            <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
              {repeats > 0 ? `Confirmar retirada (+${repeats} repetição(ões))` : "Confirmar retirada"}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
          </form>
        ) : (
          <div>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setConfirming(true);
                setTimeout(() => reasonRef.current?.focus(), 0);
              }}
            >
              Retirar
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

/** Trecho da transcrição em volta da fala que gerou o alerta. */
function TranscriptContext({ client, segmentId, debateId }: { client: SupabaseClient; segmentId: number; debateId: string }) {
  const [rows, setRows] = useState<{ id: number; speaker_label: string | null; text: string }[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [before, after] = await Promise.all([
        client
          .from("segments")
          .select("id, speaker_label, text")
          .eq("debate_id", debateId)
          .lte("id", segmentId)
          .order("id", { ascending: false })
          .limit(4),
        client
          .from("segments")
          .select("id, speaker_label, text")
          .eq("debate_id", debateId)
          .gt("id", segmentId)
          .order("id", { ascending: true })
          .limit(2),
      ]);
      if (!alive) return;
      const list = [...((before.data ?? []) as { id: number; speaker_label: string | null; text: string }[]).reverse(), ...((after.data ?? []) as { id: number; speaker_label: string | null; text: string }[])];
      setRows(list);
    })();
    return () => {
      alive = false;
    };
  }, [client, segmentId, debateId]);

  const content = useMemo(() => {
    if (rows === null) return <p className="text-muted">Carregando transcrição…</p>;
    if (rows.length === 0) return <p className="text-muted">Transcrição indisponível.</p>;
    return rows.map((r) => (
      <p key={r.id} className={r.id === segmentId ? "rounded bg-yellow-bg px-1 text-yellow-fg" : ""}>
        <span className="mr-1 text-xs text-muted">{r.speaker_label ?? "?"}:</span>
        {r.text}
      </p>
    ));
  }, [rows, segmentId]);

  return (
    <details className="mt-3 rounded-lg border border-border text-sm" open>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted">Transcrição em volta</summary>
      <div className="flex flex-col gap-1 px-3 pb-3">{content}</div>
    </details>
  );
}
