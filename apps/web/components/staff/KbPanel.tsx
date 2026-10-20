"use client";

import type { KbJobCreate } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatDateTime, formatTimeSec } from "@/lib/format";
import { jobState, type KbJobView, type KbStatus } from "@/lib/staff/kb";
import { Button, Card, ErrorText, Field, OkText, Pill, errMsg, inputCls } from "./ui";
import { useNow } from "./useStaffData";

const KEY_HELP: Record<string, string> = {
  SUPABASE_SERVICE_ROLE_KEY: "grava na base",
  VOYAGE_API_KEY: "embeddings (busca por sentido)",
  GOOGLE_FACTCHECK_API_KEY: "Google Fact Check",
  APIFY_TOKEN: "sites das agências, busca e YouTube",
  CRON_SECRET: "continuar sozinho e cron diário",
};

const DOC_TYPES = [
  ["programa", "Programa de governo"],
  ["entrevista", "Entrevista"],
  ["discurso", "Discurso"],
  ["debate", "Debate"],
  ["lei", "Lei"],
  ["votacao", "Votação"],
  ["noticia", "Notícia"],
  ["dado", "Dado / relatório"],
  ["outro", "Outro"],
] as const;
const PEOPLE = ["Lula", "Flávio Bolsonaro", "Jair Bolsonaro"];
const APIFY_COST = "Usa créditos do Apify (teto de US$ 5 por execução). Continuar?";

/** Chama /api/kb/* com o token da sessão do editor (o servidor confere is_editor e 2FA). */
async function kbFetch<T>(client: SupabaseClient, path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("sessão expirada: entre de novo");
  const r = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), Authorization: `Bearer ${token}` },
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

type DocReq = Extract<KbJobCreate, { preset: "documento" }>;
type VideoReq = Extract<KbJobCreate, { preset: "youtube" }>;

const pending = (j: KbJobView) => j.status === "queued" || j.status === "running";

/** Painel da carga da base: o que já tem, o que está rodando e botões para rodar mais. */
export function KbPanel({ client }: { client: SupabaseClient }) {
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastCounts = useRef(0);
  const now = useNow(5000);

  const load = useCallback(
    async (withCounts = false) => {
      const counts = withCounts || Date.now() - lastCounts.current > 30_000;
      try {
        const s = await kbFetch<KbStatus>(client, `/api/kb/status${counts ? "?counts=1" : ""}`);
        if (counts) lastCounts.current = Date.now();
        setStatus((prev) => (counts || !prev ? s : { ...s, counts: prev.counts, counts_error: prev.counts_error }));
        setError(null);
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [client],
  );

  const running = status?.jobs.some(pending) ?? false;
  useEffect(() => {
    void load(true);
  }, [load]);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, running ? 4000 : 20_000);
    return () => clearInterval(id);
  }, [load, running]);

  async function start(req: KbJobCreate, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await kbFetch<{ title: string; notes: string[] }>(client, "/api/kb/jobs", { method: "POST", body: JSON.stringify(req) });
      setOk(`Tarefa criada: ${r.title}.${r.notes.length ? ` Aviso: ${r.notes.join(" ")}` : ""}`);
      await load(true);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    if (!window.confirm("Cancelar esta tarefa? O que já entrou na base fica.")) return;
    try {
      await kbFetch(client, `/api/kb/jobs/${id}/cancel`, { method: "POST" });
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <KbPanelView
      status={status}
      error={error}
      ok={ok}
      busy={busy}
      now={now}
      onRefresh={() => void load(true)}
      onStart={(r, c) => void start(r, c)}
      onCancel={(id) => void cancel(id)}
    />
  );
}

/** Só a apresentação (o /admin/demo usa com dados fictícios). */
export function KbPanelView({
  status,
  error,
  ok,
  busy,
  now,
  onRefresh,
  onStart,
  onCancel,
}: {
  status: KbStatus | null;
  error: string | null;
  ok: string | null;
  busy: boolean;
  now: number;
  onRefresh: () => void;
  onStart: (r: KbJobCreate, confirm?: string) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <Card id="base" title="Base de conhecimento" actions={<Button onClick={onRefresh}>Atualizar</Button>}>
      <div className="flex flex-col gap-4">
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
        {status ? <KeysRow env={status.env} /> : <p className="text-sm text-muted">Carregando…</p>}
        {status ? <Coverage status={status} /> : null}
        <Actions busy={busy} env={status?.env ?? {}} onStart={onStart} />
        <section aria-labelledby="kb-jobs-title" className="flex flex-col gap-2">
          <h3 id="kb-jobs-title" className="text-sm font-semibold">
            Tarefas
          </h3>
          {status && !status.jobs.length ? <p className="text-sm text-muted">Nenhuma carga pedida ainda.</p> : null}
          {status?.jobs.map((j, i) => <JobItem key={j.id} job={j} now={now} open={i === 0 && pending(j)} onCancel={onCancel} />)}
        </section>
      </div>
    </Card>
  );
}

function KeysRow({ env }: { env: Record<string, boolean> }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm font-medium">Chaves na Vercel</p>
      <ul className="flex flex-wrap gap-1.5">
        {Object.entries(env).map(([k, present]) => (
          <li key={k} title={KEY_HELP[k]}>
            <Pill tone={present ? "ok" : "bad"}>
              {present ? "✓" : "✗"} {k}
            </Pill>
          </li>
        ))}
      </ul>
      {env.CRON_SECRET === false ? (
        <p className="text-xs text-muted">Sem CRON_SECRET a carga só avança enquanto este painel estiver aberto.</p>
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{children}</dd>
    </div>
  );
}

function Coverage({ status }: { status: KbStatus }) {
  const c = status.counts;
  if (status.counts_error) return <ErrorText>Resumo da base: {status.counts_error}</ErrorText>;
  if (!c) return null;
  const n = (x: number) => x.toLocaleString("pt-BR");
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Checagens (L1)">
          <strong>{n(c.kb_factchecks)}</strong>
          {c.kb_factchecks_sem_embedding ? <span className="text-muted"> · {n(c.kb_factchecks_sem_embedding)} sem embedding</span> : null}
          {c.ultima_checagem ? <span className="block text-xs text-muted">mais recente: {formatDateTime(c.ultima_checagem)}</span> : null}
        </Stat>
        <Stat label="Indicadores (L2)">
          <strong>{n(c.indicator_series)}</strong> séries · {n(c.indicator_values)} valores
        </Stat>
        <Stat label="Documentos (L3)">
          <strong>{n(c.kb_documents)}</strong> docs · {n(c.kb_chunks)} trechos
          {c.kb_chunks_sem_embedding ? <span className="text-muted"> · {n(c.kb_chunks_sem_embedding)} sem embedding</span> : null}
        </Stat>
        <Stat label="Fontes com nível">
          <strong>{n(c.source_tiers)}</strong> domínios
        </Stat>
      </dl>
      {c.series.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Séries carregadas ({c.series.length})</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-3 font-medium">Série</th>
                  <th className="py-1 pr-3 text-right font-medium">Valores</th>
                  <th className="py-1 font-medium">Até</th>
                </tr>
              </thead>
              <tbody>
                {c.series.map((s) => (
                  <tr key={s.code} className="border-t border-border">
                    <td className="py-1 pr-3">
                      {s.name}
                      {s.aggregation ? null : <span className="ml-1 text-xs text-red-fg">(sem agregação: rode Indicadores)</span>}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{n(s.values)}</td>
                    <td className="py-1 tabular-nums">{s.last ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function Actions({ busy, env, onStart }: { busy: boolean; env: Record<string, boolean>; onStart: (r: KbJobCreate, confirm?: string) => void }) {
  const [since, setSince] = useState("2025-01-01");
  const [discursos, setDiscursos] = useState(false);
  const noApify = env.APIFY_TOKEN === false;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <p className="text-sm">
          <strong>Carga completa</strong>: fontes, indicadores do BCB e IBGE, checagens (Google + feeds das agências), votações do Flávio no
          Senado e embeddings. Roda em segundo plano, em rodadas de ~3 min; pode fechar a página.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Checagens desde" htmlFor="kb-since">
            <input id="kb-since" type="date" className={inputCls} value={since} onChange={(e) => setSince(e.target.value)} />
          </Field>
          <Button variant="primary" disabled={busy || !since} onClick={() => onStart({ preset: "carga-completa", since })}>
            Rodar carga completa
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => onStart({ preset: "fontes" })}>
          Fontes
        </Button>
        <Button disabled={busy} onClick={() => onStart({ preset: "indicadores" })}>
          Indicadores
        </Button>
        <Button disabled={busy || !since} onClick={() => onStart({ preset: "checagens", since, source: "all" })}>
          Checagens desde {since || "…"}
        </Button>
        <span className="inline-flex items-center gap-2">
          <Button disabled={busy} onClick={() => onStart({ preset: "senado", discursos })}>
            Senado
          </Button>
          <label className="inline-flex items-center gap-1 text-sm">
            <input type="checkbox" checked={discursos} onChange={(e) => setDiscursos(e.target.checked)} /> com discursos
          </label>
        </span>
        <Button disabled={busy} onClick={() => onStart({ preset: "embeddings" })}>
          Embeddings faltando
        </Button>
        <Button disabled={busy} onClick={() => onStart({ preset: "atualizacao-diaria" })}>
          Atualização diária
        </Button>
        <Button disabled={busy || noApify} title={noApify ? "APIFY_TOKEN não configurado" : undefined} onClick={() => onStart({ preset: "apify-agencias" }, APIFY_COST)}>
          Sites das agências (Apify)
        </Button>
        <Button disabled={busy || noApify} title={noApify ? "APIFY_TOKEN não configurado" : undefined} onClick={() => onStart({ preset: "apify-busca" }, APIFY_COST)}>
          Busca de checagens (Apify)
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SourceForm
          kind="documento"
          title="Documento por URL"
          hint="Página ou PDF público (programa de governo, entrevista transcrita, relatório). O nível da fonte sai do domínio."
          busy={busy}
          onStart={onStart}
        />
        <SourceForm
          kind="youtube"
          title="Vídeo do YouTube (transcrição via Apify)"
          hint="Ex.: o debate de ontem. Legenda automática entra como fonte nível 4: ajuda a achar contexto, nunca sustenta alerta sozinha."
          busy={busy || noApify}
          onStart={(r) => onStart(r, APIFY_COST)}
        />
      </div>
    </div>
  );
}

function SourceForm({
  kind,
  title,
  hint,
  busy,
  onStart,
}: {
  kind: "documento" | "youtube";
  title: string;
  hint: string;
  busy: boolean;
  onStart: (r: KbJobCreate) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [docType, setDocType] = useState(kind === "youtube" ? "debate" : "programa");
  const [person, setPerson] = useState("");
  const [date, setDate] = useState("");
  const id = (f: string) => `kb-${kind}-${f}`;
  const types = kind === "youtube" ? DOC_TYPES.filter(([v]) => v === "debate" || v === "entrevista" || v === "discurso") : DOC_TYPES;

  function submit(e: FormEvent) {
    e.preventDefault();
    const common = { url: url.trim(), person: person || null, published_at: date || null };
    if (kind === "documento") onStart({ preset: "documento", ...common, title: name.trim(), doc_type: docType as DocReq["doc_type"] });
    else onStart({ preset: "youtube", ...common, title: name.trim() || null, doc_type: docType as VideoReq["doc_type"] });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs text-muted">{hint}</p>
      <Field label="URL" htmlFor={id("url")}>
        <input id={id("url")} type="url" required className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
      </Field>
      <Field label={kind === "youtube" ? "Título (opcional)" : "Título"} htmlFor={id("title")}>
        <input id={id("title")} required={kind === "documento"} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Tipo" htmlFor={id("type")}>
          <select id={id("type")} className={inputCls} value={docType} onChange={(e) => setDocType(e.target.value)}>
            {types.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pessoa" htmlFor={id("person")}>
          <select id={id("person")} className={inputCls} value={person} onChange={(e) => setPerson(e.target.value)}>
            <option value="">—</option>
            {PEOPLE.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Data" htmlFor={id("date")}>
          <input id={id("date")} type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="secondary" disabled={busy}>
          Adicionar à base
        </Button>
      </div>
    </form>
  );
}

const LEVEL_CLS = { info: "text-muted", warn: "text-yellow-fg", error: "text-red-fg" } as const;

function JobItem({ job, now, open, onCancel }: { job: KbJobView; now: number; open: boolean; onCancel: (id: string) => void }) {
  const state = jobState(job, now);
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{job.title}</h4>
        <div className="flex items-center gap-2">
          <Pill tone={state.tone}>{state.text}</Pill>
          {pending(job) ? (
            <Button variant="ghost" className="min-h-8 px-2 py-1" onClick={() => onCancel(job.id)}>
              Cancelar
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted tabular-nums">
        pedida {formatDateTime(job.created_at)} · {job.steps_done} etapas feitas · {job.steps_pending} na fila
        {job.steps_failed ? ` · ${job.steps_failed} com falha` : ""}
        {job.finished_at ? ` · terminou ${formatDateTime(job.finished_at)}` : ""}
      </p>
      {job.current_label && pending(job) ? <p className="text-sm">Agora: {job.current_label}</p> : null}
      {job.log.length ? (
        <details open={open} className="text-xs">
          <summary className="cursor-pointer text-muted">Log ({job.log.length} linhas mais recentes)</summary>
          <ol className="mt-1 max-h-72 overflow-y-auto font-mono leading-relaxed">
            {job.log.map((l, i) => (
              <li key={i} className={`break-words ${LEVEL_CLS[l.level]}`}>
                <span className="tabular-nums">{formatTimeSec(l.t)}</span> {l.msg}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}
