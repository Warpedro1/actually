import "server-only";
import type { ApiUsageSummary, ApiUsageWindow } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CountedWindow, UsageCard, UsageLine, UsageReport } from "@/lib/staff/usage";
import { errorMessage } from "./http";

// Painel "Uso das APIs" do /admin: o que cada provedor informa oficialmente
// (saldo, uso do ciclo, custo) + o que o próprio sistema contou (api_usage).
// Nunca devolve chave; cada provedor tem 5 s e falha isolada (vira status).

const TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;

type Probe = Pick<UsageCard, "status" | "message" | "official">;

class HttpStatus extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  if (!res.ok) throw new HttpStatus(res.status);
  return res.json();
}

/** Erro de uma consulta → status do cartão (sem vazar corpo de resposta). */
function failed(err: unknown): Probe {
  if (err instanceof HttpStatus && (err.status === 401 || err.status === 403)) {
    return { status: "sem_permissao", message: `a chave foi recusada (HTTP ${err.status})`, official: [] };
  }
  if (err instanceof FormatError) return { status: "formato", message: err.message, official: [] };
  const msg = err instanceof Error && err.name === "TimeoutError" ? "sem resposta em 5 s" : errorMessage(err);
  return { status: "erro", message: msg, official: [] };
}

class FormatError extends Error {}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const usd = (v: number) => `US$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
const mb = (bytes: number) => (bytes / 1024 / 1024).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

// --- provedores ----------------------------------------------------------------

/** Custo oficial do mês (Admin API: cost_report em centavos, buckets diários). */
export async function anthropicOfficial(now = new Date()): Promise<Probe> {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) {
    return {
      status: "sem_chave",
      message: "sem ANTHROPIC_ADMIN_KEY: só o custo estimado pela contagem (contas individuais não têm Admin API)",
      official: [],
    };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  let cents = 0;
  let page: string | null = null;
  try {
    for (let i = 0; i < 3; i++) {
      const qs = new URLSearchParams({ starting_at: start.toISOString(), ending_at: end.toISOString(), limit: "31" });
      if (page) qs.set("page", page);
      const body = (await getJson(`https://api.anthropic.com/v1/organizations/cost_report?${qs}`, {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "user-agent": "actually/1.0 (painel de uso)",
      })) as { data?: { results?: { amount?: unknown }[] }[]; has_more?: boolean; next_page?: string | null };
      if (!Array.isArray(body.data)) throw new FormatError("cost_report sem `data`");
      for (const bucket of body.data) for (const r of bucket.results ?? []) cents += num(r.amount) ?? 0;
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
  } catch (err) {
    return failed(err);
  }
  return { status: "ok", official: [{ label: "Custo no mês (oficial)", text: usd(cents / 100) }] };
}

/** Saldo do projeto Deepgram (Management API). */
export async function deepgramOfficial(): Promise<Probe> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return { status: "sem_chave", message: "sem DEEPGRAM_API_KEY na Vercel (a da máquina de captura não aparece aqui)", official: [] };
  const headers = { Authorization: `Token ${key}` };
  try {
    const projects = (await getJson("https://api.deepgram.com/v1/projects", headers)) as { projects?: { project_id?: string; name?: string }[] };
    const project = projects.projects?.[0];
    if (!project?.project_id) throw new FormatError("nenhum projeto visível para esta chave");
    const body = (await getJson(`https://api.deepgram.com/v1/projects/${encodeURIComponent(project.project_id)}/balances`, headers)) as {
      balances?: { amount?: unknown; units?: string }[];
    };
    if (!Array.isArray(body.balances)) throw new FormatError("balances sem a lista `balances`");
    const lines: UsageLine[] = body.balances.map((b) => {
      const amount = num(b.amount) ?? 0;
      const units = (b.units ?? "").toLowerCase();
      return { label: `Saldo${project.name ? ` (${project.name})` : ""}`, text: units === "usd" || !units ? usd(amount) : `${int(amount)} ${b.units}` };
    });
    return { status: "ok", official: lines.length ? lines : [{ label: "Saldo", text: "nenhum saldo listado" }] };
  } catch (err) {
    return failed(err);
  }
}

/** Uso do ciclo mensal × limite (Apify). */
export async function apifyOfficial(): Promise<Probe> {
  const token = process.env.APIFY_TOKEN;
  if (!token) return { status: "sem_chave", message: "sem APIFY_TOKEN na Vercel", official: [] };
  try {
    const body = (await getJson("https://api.apify.com/v2/users/me/limits", { Authorization: `Bearer ${token}` })) as {
      data?: { current?: { monthlyUsageUsd?: unknown }; limits?: { maxMonthlyUsageUsd?: unknown }; monthlyUsageCycle?: { endAt?: string } };
    };
    const used = num(body.data?.current?.monthlyUsageUsd);
    const limit = num(body.data?.limits?.maxMonthlyUsageUsd);
    if (used === null) throw new FormatError("limits sem data.current.monthlyUsageUsd");
    const end = body.data?.monthlyUsageCycle?.endAt;
    return {
      status: "ok",
      official: [
        {
          label: "Uso no ciclo mensal",
          text: `${usd(used)}${limit !== null ? ` de ${usd(limit)}` : ""}${end ? ` (renova ${end.slice(0, 10)})` : ""}`,
          used,
          ...(limit !== null ? { limit } : {}),
        },
      ],
    };
  } catch (err) {
    return failed(err);
  }
}

/** Créditos usados × limite da chave e do plano (Tavily). */
export async function tavilyOfficial(): Promise<Probe> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { status: "sem_chave", message: "sem TAVILY_API_KEY", official: [] };
  try {
    const body = (await getJson("https://api.tavily.com/usage", { Authorization: `Bearer ${key}` })) as {
      key?: { usage?: unknown; limit?: unknown };
      account?: { current_plan?: string; plan_usage?: unknown; plan_limit?: unknown };
    };
    const lines: UsageLine[] = [];
    const planUsed = num(body.account?.plan_usage);
    const planLimit = num(body.account?.plan_limit);
    if (planUsed !== null) {
      lines.push({
        label: `Créditos do plano${body.account?.current_plan ? ` (${body.account.current_plan})` : ""}`,
        text: `${int(planUsed)}${planLimit !== null ? ` de ${int(planLimit)}` : ""}`,
        used: planUsed,
        ...(planLimit !== null ? { limit: planLimit } : {}),
      });
    }
    const keyUsed = num(body.key?.usage);
    const keyLimit = num(body.key?.limit);
    if (keyUsed !== null) {
      lines.push({ label: "Créditos desta chave", text: `${int(keyUsed)}${keyLimit !== null ? ` de ${int(keyLimit)}` : ""}`, used: keyUsed, ...(keyLimit !== null ? { limit: keyLimit } : {}) });
    }
    if (!lines.length) throw new FormatError("usage sem key.usage nem account.plan_usage");
    return { status: "ok", official: lines };
  } catch (err) {
    return failed(err);
  }
}

/** Tamanho do banco × limite do plano (Supabase; o limite vem de SUPABASE_DB_LIMIT_MB). */
export async function supabaseOfficial(db: SupabaseClient): Promise<Probe> {
  const limitMb = Number(process.env.SUPABASE_DB_LIMIT_MB) || 500;
  const { data, error } = await db.rpc("ops_db_size");
  if (error) return { status: "erro", message: `ops_db_size: ${error.message}`, official: [] };
  const s = data as { db_bytes?: unknown; tables?: { table: string; bytes: number }[] } | null;
  const bytes = num(s?.db_bytes);
  if (bytes === null) return { status: "formato", message: "ops_db_size sem db_bytes", official: [] };
  const top = s?.tables?.[0];
  return {
    status: "ok",
    official: [
      { label: "Banco de dados", text: `${mb(bytes)} MB de ${int(limitMb)} MB`, used: bytes / 1024 / 1024, limit: limitMb },
      ...(top ? [{ label: "Maior tabela", text: `${top.table} (${mb(top.bytes)} MB)` }] : []),
    ],
  };
}

// --- montagem ----------------------------------------------------------------

function countedFor(summary: ApiUsageSummary | null, provider: string): CountedWindow[] {
  if (!summary) return [];
  const by = new Map<ApiUsageWindow, CountedWindow>();
  for (const u of summary.usage) {
    if (u.provider !== provider) continue;
    const w = by.get(u.janela) ?? { janela: u.janela, requests: 0, input_tokens: 0, output_tokens: 0, units: 0, cost_usd: 0 };
    w.requests += Number(u.requests) || 0;
    w.input_tokens += Number(u.input_tokens) || 0;
    w.output_tokens += Number(u.output_tokens) || 0;
    w.units += Number(u.units) || 0;
    w.cost_usd += Number(u.cost_usd) || 0;
    by.set(u.janela, w);
  }
  const order: ApiUsageWindow[] = ["hora", "hoje", "24h", "mes"];
  return order.map((j) => by.get(j)).filter((x): x is CountedWindow => !!x);
}

const settle = async (p: Promise<Probe>): Promise<Probe> => p.catch((err) => failed(err));

export async function buildUsageReport(db: SupabaseClient, now = new Date()): Promise<UsageReport> {
  const [summaryRes, anthropic, deepgram, apify, tavily, supabase] = await Promise.all([
    Promise.resolve(db.rpc("api_usage_summary")).then(
      (r) => (r.error ? { error: r.error.message, data: null } : { error: null, data: r.data as ApiUsageSummary }),
      (e: unknown) => ({ error: errorMessage(e), data: null }),
    ),
    settle(anthropicOfficial(now)),
    settle(deepgramOfficial()),
    settle(apifyOfficial()),
    settle(tavilyOfficial()),
    settle(supabaseOfficial(db)),
  ]);
  const summary = summaryRes.data;
  const rl = (p: string) => summary?.ratelimits?.[p] ?? null;
  const noApi = (message: string): Probe => ({ status: "sem_api", message, official: [] });
  const cards: UsageCard[] = [
    {
      id: "anthropic", name: "Anthropic (Claude)", link: "https://platform.claude.com/usage", ...anthropic,
      message: [anthropic.message, "o saldo de créditos não é exposto por API: confira no Console"].filter(Boolean).join(" · "),
      counted: countedFor(summary, "anthropic"), ratelimit: rl("anthropic"),
    },
    { id: "deepgram", name: "Deepgram (transcrição)", link: "https://console.deepgram.com/", ...deepgram, counted: [], ratelimit: null },
    {
      id: "voyage", name: "Voyage (embeddings e rerank)", link: "https://dashboard.voyageai.com/",
      ...noApi("a API não informa uso nem saldo: números contados pelo actually"), counted: countedFor(summary, "voyage"), ratelimit: rl("voyage"),
    },
    { id: "tavily", name: "Tavily (busca web)", link: "https://app.tavily.com/", ...tavily, counted: countedFor(summary, "tavily"), ratelimit: rl("tavily") },
    {
      id: "google_factcheck", name: "Google Fact Check", link: "https://console.cloud.google.com/apis/api/factchecktools.googleapis.com/quotas",
      ...noApi("a cota diária fica no Google Cloud Console: números contados pelo actually"), counted: countedFor(summary, "google_factcheck"), ratelimit: null,
    },
    { id: "apify", name: "Apify (robôs)", link: "https://console.apify.com/billing", ...apify, counted: countedFor(summary, "apify"), ratelimit: null },
    { id: "supabase", name: "Supabase (banco)", link: "https://supabase.com/dashboard/project/_/settings/billing/usage", ...supabase, counted: [], ratelimit: null },
    {
      id: "vercel", name: "Vercel (site e funções)", link: "https://vercel.com/dashboard/usage",
      ...noApi("uso e cota (pedidos, tráfego, funções) só no painel da Vercel"), counted: [], ratelimit: null,
    },
  ];
  return { generated_at: now.toISOString(), cards, counted_error: summaryRes.error };
}

let cache: { at: number; report: UsageReport } | null = null;

/** Com cache de 60 s por instância: a Anthropic recomenda no máximo 1 consulta/min ao relatório. */
export async function cachedUsageReport(db: SupabaseClient, fresh = false): Promise<UsageReport> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.report;
  const report = await buildUsageReport(db);
  cache = { at: Date.now(), report };
  return report;
}

/** Testes. */
export function resetUsageCache(): void {
  cache = null;
}
