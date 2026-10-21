// L4 — busca web (Tavily) restrita aos domínios de tier 1–2. Começa junto com a
// base e só é usada quando a base vem fraca (ver retrieve/index.ts). O conteúdo
// das páginas é guardado inteiro: a citação do verificador é conferida contra ele.
import { tierForUrl, lookupSource, webSearchDomains } from "@actually/db";
import { RERANK_MIN_RELEVANCE, RERANK_TOP_K, RETRIEVE_COUNT, TAVILY_SEARCH_URL, TIMEOUTS_MS } from "../config";
import type { RerankFn } from "../rerank";
import type { UsageMeter } from "../usage";
import type { EvidenceCandidate } from "../types";

export interface WebResult {
  url: string;
  title: string;
  /** Trecho que o buscador achou relevante. */
  content: string;
  /** Página inteira (texto) — usada na checagem da citação. */
  raw_content: string | null;
  published_date: string | null;
  score: number;
}

export type WebSearchFn = (query: string, opts: { includeDomains: string[]; maxResults: number }) => Promise<WebResult[]>;

interface TavilyResponse {
  results: {
    url: string; title?: string; content?: string; raw_content?: string | null;
    published_date?: string | null; score?: number;
  }[];
}

export function tavilySearch(apiKey: string, fetchImpl: typeof fetch = fetch, usage?: UsageMeter): WebSearchFn {
  return async (query, { includeDomains, maxResults }) => {
    const res = await fetchImpl(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        topic: "general",
        max_results: maxResults,
        include_domains: includeDomains,
        include_raw_content: "text",
        include_answer: false,
      }),
      signal: AbortSignal.timeout(TIMEOUTS_MS.L4),
    });
    usage?.ratelimit("tavily", res.headers);
    if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 300)}`);
    // busca "basic" = 1 crédito da Tavily
    usage?.record({ provider: "tavily", requests: 1, units: 1 });
    const json = (await res.json()) as TavilyResponse;
    return (json.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? "",
      content: r.content ?? "",
      raw_content: r.raw_content ?? null,
      published_date: r.published_date ?? null,
      score: r.score ?? 0,
    }));
  };
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Busca, filtra por domínio permitido, reranqueia e devolve candidatos L4. */
export async function retrieveWeb(
  query: string,
  search: WebSearchFn,
  rerank: RerankFn,
): Promise<EvidenceCandidate[]> {
  const domains = webSearchDomains();
  const results = (await search(query, { includeDomains: domains, maxResults: RETRIEVE_COUNT.L4 }))
    // defesa em profundidade: o buscador pode ignorar include_domains
    .filter((r) => /^https?:\/\//i.test(r.url) && tierForUrl(r.url) <= 2)
    .filter((r) => (r.raw_content ?? r.content).trim().length > 0);
  if (!results.length) return [];

  const docs = results.map((r) => `${r.title}\n${r.content}`);
  const hits = await rerank(query, docs, RERANK_TOP_K.L4);
  return hits
    .filter((h) => h.relevance_score >= RERANK_MIN_RELEVANCE.L4)
    .map((h) => {
      const r = results[h.index]!;
      const src = lookupSource(r.url);
      return {
        layer: "L4" as const,
        evidence_type: "web" as const,
        url: r.url,
        source_name: src?.name ?? hostname(r.url),
        source_tier: tierForUrl(r.url),
        published_at: r.published_date,
        title: r.title || null,
        // texto inteiro da página; o trecho do buscador entra se a página não veio
        text: r.raw_content && r.raw_content.trim() ? r.raw_content : r.content,
        relevance: h.relevance_score,
      };
    });
}
