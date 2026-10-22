// Tavily na carga da base: ler a página que recusa o download direto (UOL Confere e
// AFP Checamos respondem 403 "Access Denied" para os servidores da Vercel) e buscar as
// checagens recentes das agências sem feed (g1 Fato ou Fake).
//
// Nunca serve para contornar robots.txt: quem chama só cai no extract depois de um
// download recusado por HTTP/rede (canFallBackToTavily), e a página que chega pronta (busca,
// fila kb_web_finds) só é usada se o robots.txt da URL permitir (robotsPermits). Texto do
// extract não substitui documento que já está na base (ingestFetched). Sem TAVILY_API_KEY
// ⇒ null/[] com aviso. O uso entra no medidor da carga (lib/usage.ts).
import { fetchJson, HttpError, RobotsDisallowedError } from "./http";
import { recordUsage } from "./usage";

export const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
/** Créditos da Tavily: busca "basic" = 1; extract "basic" = 1 a cada 5 URLs lidas. */
export const TAVILY_CREDITS = { search: 1, extractPerUrl: 0.2 } as const;
const TIMEOUT_MS = 30_000;

export type Warn = (...a: unknown[]) => void;
export type TimeRange = "day" | "week" | "month" | "year";

export interface TavilyPage {
  title: string | null;
  /** Texto bruto da página (a limpeza fica com quem chama). */
  text: string;
}

export interface TavilySearchResult {
  url: string;
  title: string;
  /** Página inteira em texto (include_raw_content "text"); null se a Tavily não leu. */
  raw_content: string | null;
  published_date: string | null;
}

interface ExtractResponse {
  results?: { url?: string; title?: string | null; raw_content?: string | null }[];
  failed_results?: { url?: string; error?: string | null }[];
}

interface SearchResponse {
  results?: { url?: string; title?: string | null; raw_content?: string | null; published_date?: string | null }[];
}

function apiKey(): string | null {
  return process.env.TAVILY_API_KEY?.trim() || null;
}

export function hasTavilyKey(): boolean {
  return apiKey() !== null;
}

function request(key: string, body: Record<string, unknown>) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    timeoutMs: TIMEOUT_MS,
    retries: 1,
  };
}

/**
 * Download direto recusado por HTTP (403, 5xx...) ou rede (timeout): vale tentar a Tavily.
 * robots.txt proibindo NUNCA vale; página que não existe (404/410) também não.
 */
export function canFallBackToTavily(e: unknown): boolean {
  if (e instanceof RobotsDisallowedError) return false;
  if (e instanceof HttpError) return e.status !== 404 && e.status !== 410;
  return true;
}

/** Lê uma página pela Tavily. Qualquer falha (sem chave, API fora, URL não lida) ⇒ null com aviso. */
export async function tavilyExtract(url: string, opts: { warn?: Warn } = {}): Promise<TavilyPage | null> {
  const key = apiKey();
  if (!key) {
    opts.warn?.(`TAVILY_API_KEY ausente: ${url} não foi lida pela Tavily`);
    return null;
  }
  let res: ExtractResponse;
  try {
    res = await fetchJson<ExtractResponse>(TAVILY_EXTRACT_URL, request(key, { urls: [url], extract_depth: "basic", format: "text" }));
  } catch (e) {
    opts.warn?.(`Tavily extract: ${(e as Error).message}`);
    return null;
  }
  const hit = (res.results ?? []).find((r) => r.raw_content?.trim());
  // URL que a Tavily não conseguiu ler não é cobrada
  recordUsage({ provider: "tavily", model: "extract", requests: 1, units: hit ? TAVILY_CREDITS.extractPerUrl : 0 });
  if (!hit) {
    const why = res.failed_results?.find((f) => f.error)?.error;
    opts.warn?.(`Tavily não leu ${url}${why ? `: ${why}` : ""}`);
    return null;
  }
  return { title: hit.title?.trim() || null, text: hit.raw_content! };
}

/**
 * Busca com a página inteira em texto. Sem chave ⇒ [] com aviso; erro da API ⇒ exceção
 * (a etapa que chamou aparece como falha no log da tarefa).
 */
export async function tavilySearch(
  query: string,
  opts: { includeDomains: string[]; timeRange?: TimeRange; maxResults: number; warn?: Warn },
): Promise<TavilySearchResult[]> {
  const key = apiKey();
  if (!key) {
    opts.warn?.(`TAVILY_API_KEY ausente: busca "${query}" pulada`);
    return [];
  }
  const res = await fetchJson<SearchResponse>(
    TAVILY_SEARCH_URL,
    request(key, {
      query,
      search_depth: "basic",
      topic: "general",
      max_results: opts.maxResults,
      include_domains: opts.includeDomains,
      include_raw_content: "text",
      include_answer: false,
      ...(opts.timeRange ? { time_range: opts.timeRange } : {}),
    }),
  );
  recordUsage({ provider: "tavily", model: "search", requests: 1, units: TAVILY_CREDITS.search });
  return (res.results ?? [])
    .filter((r): r is typeof r & { url: string } => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
    .map((r) => ({
      url: r.url,
      title: r.title?.trim() ?? "",
      raw_content: r.raw_content?.trim() ? r.raw_content : null,
      published_date: r.published_date ?? null,
    }));
}

/** Janela da busca que cobre desde `since` (a data exata é filtrada depois). */
export function timeRangeSince(since: string, nowMs: number): TimeRange | undefined {
  const days = (nowMs - Date.parse(since)) / 86_400_000;
  if (!Number.isFinite(days)) return undefined;
  if (days <= 1) return "day";
  if (days <= 7) return "week";
  if (days <= 31) return "month";
  if (days <= 366) return "year";
  return undefined;
}
