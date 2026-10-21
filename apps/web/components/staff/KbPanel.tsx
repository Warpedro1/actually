"use client";

import type { KbJobCreate } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatDateTime, formatTimeSec } from "@/lib/format";
import { staffFetch } from "@/lib/staff/fetch";
import { jobState, type KbJobView, type KbStatus } from "@/lib/staff/kb";
import { ConfirmBox } from "./ConfirmBox";
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
const APIFY_COST = "Usa créditos do Apify (até US$ 5 por execução).";

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
        const s = await staffFetch<KbStatus>(client, `/api/kb/status${counts ? "?counts=1" : ""}`);
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

  async function start(req: KbJobCreate) {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await staffFetch<{ title: string; notes: string[] }>(client, "/api/kb/jobs", { method: "POST", body: JSON.stringify(req) });
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
      await staffFetch(client, `/api/kb/jobs/${id}/cancel`, { method: "POST" });
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
      onStart={(r) => void start(r)}
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
  onStart: (r: KbJobCreate) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <Card id="base" title="Base de conhecimento" actions={<Button onClick={onRefresh}>Atualizar</Button>}>
      <div className="flex flex-col gap-4">
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
        {status ? <KeysRow env={status.env} /> : <p className="text-sm text-muted">Carregando…</p>}
        {status ? <Coverage status={status} /> : null}
        <Actions busy={busy} env={status?.env ?? {}} jobs={status?.jobs ?? []} onStart={onStart} />
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

/** Uma ação: nome, o que faz e o botão; o clique abre a confirmação. */
function ActionItem({
  label,
  description,
  confirm,
  disabled,
  disabledReason,
  children,
  onRun,
}: {
  label: string;
  description: ReactNode;
  confirm: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  children?: ReactNode;
  onRun: () => void;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <li className="flex flex-col gap-2 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs leading-snug text-muted">{description}</p>
          {disabled && disabledReason ? <p className="text-xs text-red-fg">{disabledReason}</p> : null}
        </div>
        {!asking ? (
          <Button className="shrink-0" disabled={disabled} onClick={() => setAsking(true)}>
            {label}
          </Button>
        ) : null}
      </div>
      {children}
      {asking ? (
        <ConfirmBox
          text={confirm}
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            onRun();
          }}
        />
      ) : null}
    </li>
  );
}

function Group({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div>
        <h3 id={id} className="text-sm font-semibold">
          {title}
        </h3>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

const PRESET_NAME: Record<string, string> = {
  "carga-completa": "carga completa",
  fontes: "fontes",
  indicadores: "indicadores",
  checagens: "checagens",
  senado: "Senado",
  documento: "documento",
  youtube: "vídeo do YouTube",
  "apify-agencias": "sites das agências",
  "apify-busca": "busca de checagens",
  embeddings: "embeddings",
  "atualizacao-diaria": "atualização diária",
  "capturas-web": "capturas da web",
  "checagens-agencias": "checagens das agências",
};

/** Data AAAA-MM-DD de `days` dias atrás (padrão da busca nas agências). */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function Actions({
  busy,
  env,
  jobs,
  onStart,
}: {
  busy: boolean;
  env: Record<string, boolean>;
  jobs: KbJobView[];
  onStart: (r: KbJobCreate) => void;
}) {
  const [fullSince, setFullSince] = useState("2025-01-01");
  const [checkSince, setCheckSince] = useState("2025-01-01");
  const [discursos, setDiscursos] = useState(false);
  const [agencySince, setAgencySince] = useState(() => daysAgo(45));
  const noApify = env.APIFY_TOKEN === false;
  const noTavily = env.TAVILY_API_KEY === false;
  const noVoyage = env.VOYAGE_API_KEY === false;
  const apifyReason = noApify ? "Precisa do APIFY_TOKEN na Vercel." : undefined;

  /** Texto da confirmação + aviso se já houver tarefa igual na fila. */
  const ask = (preset: string, text: ReactNode, extra?: string) => {
    const dup = jobs.some((j) => pending(j) && j.preset === preset);
    return (
      <>
        <p>{text}</p>
        {extra ? <p className="mt-1 text-xs">{extra}</p> : null}
        {dup ? (
          <p className="mt-1 text-xs font-semibold">
            Já existe uma tarefa de {PRESET_NAME[preset] ?? preset} na fila ou rodando: esta vai esperar e repetir o trabalho.
          </p>
        ) : null}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        Cada botão pede confirmação e vira uma tarefa na lista “Tarefas” abaixo. As tarefas rodam em segundo plano, uma por vez;
        pode fechar a página. Rodar de novo atualiza o que já existe, sem duplicar.
      </p>

      <Group id="kb-g-inicial" title="Carga inicial" hint="Para encher a base do zero. Use uma vez; depois, a manutenção basta.">
        <ActionItem
          label="Rodar carga completa"
          description="Fontes confiáveis, indicadores do BCB e IBGE desde 2003, checagens desde a data escolhida, votações no Senado e embeddings."
          disabled={busy || !fullSince}
          confirm={ask(
            "carga-completa",
            `Rodar a carga completa, com checagens desde ${fullSince}?`,
            "É a tarefa mais longa: várias rodadas de ~3 min em segundo plano.",
          )}
          onRun={() => onStart({ preset: "carga-completa", since: fullSince })}
        >
          <Field label="Checagens desde" htmlFor="kb-full-since">
            <input id="kb-full-since" type="date" className={`${inputCls} sm:max-w-48`} value={fullSince} onChange={(e) => setFullSince(e.target.value)} />
          </Field>
        </ActionItem>
      </Group>

      <Group id="kb-g-manut" title="Manutenção" hint="Rápidas e baratas. Não baixam a base inteira de novo.">
        <ActionItem
          label="Atualização diária"
          description="Checagens dos últimos 3 dias + indicadores + embeddings faltando. É o mesmo que o cron roda sozinho às 6h (Brasília)."
          disabled={busy}
          confirm={ask("atualizacao-diaria", "Rodar a atualização diária agora?")}
          onRun={() => onStart({ preset: "atualizacao-diaria" })}
        />
        <ActionItem
          label="Embeddings faltando"
          description="Gera a busca por sentido só para o que entrou sem ela (ex.: falha da Voyage no meio de uma carga). Não baixa nada de fora."
          disabled={busy || noVoyage}
          disabledReason={noVoyage ? "Precisa da VOYAGE_API_KEY na Vercel." : undefined}
          confirm={ask("embeddings", "Gerar os embeddings que estão faltando?")}
          onRun={() => onStart({ preset: "embeddings" })}
        />
        <ActionItem
          label="Fontes confiáveis"
          description="Atualiza no banco a lista de sites e o nível de confiança de cada um (1 a 4). Segundos."
          disabled={busy}
          confirm={ask("fontes", "Atualizar a lista de fontes confiáveis?")}
          onRun={() => onStart({ preset: "fontes" })}
        />
        <ActionItem
          label="Processar capturas da web"
          description="Transforma em checagens e documentos as páginas que a busca web trouxe durante as checagens. Roda sozinho enquanto há debate; use se a fila parar."
          disabled={busy}
          confirm={ask("capturas-web", "Processar agora a fila de páginas capturadas da web?")}
          onRun={() => onStart({ preset: "capturas-web" })}
        />
      </Group>

      <Group id="kb-g-l1" title="Checagens já publicadas (L1)" hint="O que as agências de checagem já verificaram.">
        <ActionItem
          label="Buscar checagens"
          description="Google Fact Check (se a chave estiver na Vercel) + feeds das agências, a partir da data escolhida."
          disabled={busy || !checkSince}
          confirm={ask("checagens", `Buscar checagens publicadas desde ${checkSince}?`)}
          onRun={() => onStart({ preset: "checagens", since: checkSince, source: "all" })}
        >
          <Field label="Desde" htmlFor="kb-check-since">
            <input id="kb-check-since" type="date" className={`${inputCls} sm:max-w-48`} value={checkSince} onChange={(e) => setCheckSince(e.target.value)} />
          </Field>
        </ActionItem>
        <ActionItem
          label="Checagens recentes das agências (Tavily)"
          description="Busca pela Tavily as checagens de Lupa, Aos Fatos, Estadão Verifica, Fato ou Fake, Comprova, UOL Confere e AFP Checamos, inclusive nos sites que recusam a Vercel. Matéria com várias falas checadas entra como documento."
          disabled={busy || noTavily || !agencySince}
          disabledReason={noTavily ? "Precisa da TAVILY_API_KEY na Vercel." : undefined}
          confirm={ask(
            "checagens-agencias",
            `Buscar as checagens das agências publicadas desde ${agencySince}?`,
            "Gasta cerca de 30 créditos da Tavily (uma busca por agência e assunto).",
          )}
          onRun={() => onStart({ preset: "checagens-agencias", since: agencySince })}
        >
          <Field label="Desde" htmlFor="kb-agency-since">
            <input id="kb-agency-since" type="date" className={`${inputCls} sm:max-w-48`} value={agencySince} onChange={(e) => setAgencySince(e.target.value)} />
          </Field>
        </ActionItem>
        <ActionItem
          label="Sites das agências (Apify)"
          description="Robô percorre os sites das agências (Lupa, Aos Fatos, Estadão Verifica…) atrás de checagens que não estão no Google nem nos feeds."
          disabled={busy || noApify}
          disabledReason={apifyReason}
          confirm={ask("apify-agencias", "Rodar o robô do Apify nos sites das agências?", `${APIFY_COST} Uma execução por agência.`)}
          onRun={() => onStart({ preset: "apify-agencias" })}
        />
        <ActionItem
          label="Busca de checagens (Apify)"
          description="Pesquisa no Google por checagens recentes sobre os candidatos e temas do debate; só aproveita resultados de agências."
          disabled={busy || noApify}
          disabledReason={apifyReason}
          confirm={ask("apify-busca", "Rodar a busca de checagens no Apify?", APIFY_COST)}
          onRun={() => onStart({ preset: "apify-busca" })}
        />
      </Group>

      <Group id="kb-g-l2" title="Indicadores oficiais (L2)" hint="Números do Banco Central e do IBGE, comparados em código com o que for dito.">
        <ActionItem
          label="Indicadores"
          description="Inflação, juros, desemprego, PIB, dólar e outros, desde 2003. Alguns minutos."
          disabled={busy}
          confirm={ask("indicadores", "Baixar e atualizar os indicadores oficiais?")}
          onRun={() => onStart({ preset: "indicadores" })}
        />
      </Group>

      <Group id="kb-g-l3" title="Documentos e registros (L3)" hint="Textos de referência: votações, discursos, programas, entrevistas, debates.">
        <ActionItem
          label="Senado"
          description="Votações nominais de Flávio Bolsonaro no Senado desde 2019 (registro oficial)."
          disabled={busy}
          confirm={ask(
            "senado",
            `Baixar as votações${discursos ? " e os discursos" : ""} de Flávio Bolsonaro no Senado?`,
            discursos ? "Com discursos demora bem mais: um download por discurso." : undefined,
          )}
          onRun={() => onStart({ preset: "senado", discursos })}
        >
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={discursos} onChange={(e) => setDiscursos(e.target.checked)} />
            incluir os discursos em plenário (texto integral da taquigrafia; bem mais demorado)
          </label>
        </ActionItem>
        <li className="grid grid-cols-1 gap-3 border-t border-border pt-3 lg:grid-cols-2">
          <SourceForm
            kind="documento"
            title="Documento por URL"
            hint="Página ou PDF público (programa de governo, entrevista transcrita, relatório). O nível da fonte sai do domínio."
            busy={busy}
            jobs={jobs}
            onStart={onStart}
          />
          <SourceForm
            kind="youtube"
            title="Vídeo do YouTube (legenda via Apify)"
            hint="Ex.: o debate de ontem. Legenda automática entra como fonte nível 4: dá contexto, nunca sustenta alerta sozinha."
            busy={busy || noApify}
            disabledReason={apifyReason}
            jobs={jobs}
            onStart={onStart}
          />
        </li>
      </Group>
    </div>
  );
}

function SourceForm({
  kind,
  title,
  hint,
  busy,
  disabledReason,
  jobs,
  onStart,
}: {
  kind: "documento" | "youtube";
  title: string;
  hint: string;
  busy: boolean;
  disabledReason?: string;
  jobs: KbJobView[];
  onStart: (r: KbJobCreate) => void;
}) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [docType, setDocType] = useState(kind === "youtube" ? "debate" : "programa");
  const [person, setPerson] = useState("");
  const [date, setDate] = useState("");
  const [asking, setAsking] = useState<KbJobCreate | null>(null);
  const id = (f: string) => `kb-${kind}-${f}`;
  const types = kind === "youtube" ? DOC_TYPES.filter(([v]) => v === "debate" || v === "entrevista" || v === "discurso") : DOC_TYPES;
  const typeLabel = DOC_TYPES.find(([v]) => v === docType)?.[1] ?? docType;

  function submit(e: FormEvent) {
    e.preventDefault();
    const common = { url: url.trim(), person: person || null, published_at: date || null };
    setAsking(
      kind === "documento"
        ? { preset: "documento", ...common, title: name.trim(), doc_type: docType as DocReq["doc_type"] }
        : { preset: "youtube", ...common, title: name.trim() || null, doc_type: docType as VideoReq["doc_type"] },
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-xs text-muted">{hint}</p>
      {busy && disabledReason ? <p className="text-xs text-red-fg">{disabledReason}</p> : null}
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
      {asking ? (
        <ConfirmBox
          text={
            <>
              <p>
                Adicionar à base: <strong>{name.trim() || url.trim()}</strong> ({typeLabel}
                {person ? `, ${person}` : ""})?
              </p>
              <p className="mt-1 break-all text-xs">{url.trim()}</p>
              {kind === "youtube" ? <p className="mt-1 text-xs">{APIFY_COST} Leva alguns minutos.</p> : null}
              {jobs.some((j) => pending(j) && j.preset === kind) ? (
                <p className="mt-1 text-xs font-semibold">Já há uma tarefa deste tipo na fila: esta espera a anterior terminar.</p>
              ) : null}
            </>
          }
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            onStart(asking);
            setAsking(null);
            setUrl("");
            setName("");
            setDate("");
          }}
        />
      ) : (
        <div>
          <Button type="submit" variant="secondary" disabled={busy}>
            Adicionar à base
          </Button>
        </div>
      )}
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
