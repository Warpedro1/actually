// Checagens recentes das agências pela busca da Tavily: cobre quem não tem feed (g1 Fato
// ou Fake) e quem recusa a Vercel (UOL Confere e AFP Checamos respondem 403). A busca já
// devolve a página inteira em texto, então nada é baixado de novo. Funções puras, menos
// searchAgency.
import { lookupSource, SOURCE_TIERS } from "@actually/db";
import { tavilySearch, timeRangeSince, type TavilySearchResult, type Warn } from "../lib/tavily";
import { canonicalUrl, dateFromUrl, pageFromText, type FactcheckCandidate } from "./normalize";

/** Consultas por agência (cada uma vira uma etapa factchecks-tavily). */
export const AGENCY_QUERIES = ["Lula", "Flávio Bolsonaro", "debate", "sabatina entrevista"];
/** Resultados por busca (cada busca "basic" custa 1 crédito, qualquer que seja o número). */
export const AGENCY_SEARCH_RESULTS = 10;

/** Agências de checagem de SOURCE_TIERS (domínio com caminho quando houver). */
export function checkingAgencies(): { domain: string; name: string }[] {
  return SOURCE_TIERS.filter((t) => t.kind === "checagem").map((t) => ({ domain: t.domain, name: t.name }));
}

/** Host para include_domains ("g1.globo.com/fato-ou-fake" → "g1.globo.com"). */
export function agencyHost(domain: string): string {
  return domain.split("/")[0]!;
}

/**
 * Consulta da busca. Agência que divide o host com o resto do jornal (g1, UOL, Estadão)
 * leva o nome da seção na frente ("Fato ou Fake Lula"): sem isso a busca no host volta
 * cheia de notícia comum, que o filtro por caminho joga fora.
 */
export function agencyQuery(domain: string, query: string): string {
  if (!domain.includes("/")) return query;
  const name = lookupSource(`https://${domain}/`)?.name.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  return name ? `${name} ${query}` : query;
}

/**
 * Resultados → candidatos com a página já obtida. Fica só página de agência de
 * checagem (respeita o caminho: g1.globo.com/fato-ou-fake, noticias.uol.com.br/confere);
 * data (do buscador, da URL ou do começo do texto) anterior a `since` sai. Sem data
 * nenhuma segue, mas não vira checagem L1 (buildFactcheckRow exige data): no máximo
 * documento da agência, sem data.
 */
export function candidatesFromSearch(
  results: TavilySearchResult[],
  since: string,
): { candidates: FactcheckCandidate[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  const drop = (r: string) => (dropped[r] = (dropped[r] ?? 0) + 1);
  const sinceMs = Date.parse(since);
  const candidates: FactcheckCandidate[] = [];
  for (const r of results) {
    if (lookupSource(r.url)?.kind !== "checagem") {
      drop("fora_da_agencia");
      continue;
    }
    const url = canonicalUrl(r.url);
    // título do buscador vem com o nome do site; a limpeza fica em pageFromText, que
    // também procura a data no caminho da URL e no começo do texto
    const page = r.raw_content ? pageFromText({ url, title: r.title, text: r.raw_content, publishedAt: r.published_date }) : null;
    const date = page ? page.publishedAt : r.published_date || dateFromUrl(url);
    const dateMs = date ? Date.parse(date) : NaN;
    // sem data na URL, no buscador nem no texto da Tavily (Aos Fatos e Estadão não trazem):
    // baixa a página direto, que tem a data no HTML (e o robots.txt é conferido no download).
    // Se o download falhar, o texto da Tavily não vira checagem (sem data) e lista é recusada.
    if (!Number.isFinite(dateMs)) {
      drop("sem_data_baixar");
      candidates.push({ url, publishedAt: null });
      continue;
    }
    if (Number.isFinite(sinceMs) && dateMs < sinceMs) {
      drop("antiga");
      continue;
    }
    candidates.push({ url, publishedAt: date || null, page });
  }
  return { candidates, dropped };
}

/** Uma busca da Tavily restrita ao host da agência. */
export async function searchAgency(
  step: { domain: string; query: string; since: string },
  opts: { now: number; warn?: Warn },
): Promise<TavilySearchResult[]> {
  return tavilySearch(agencyQuery(step.domain, step.query), {
    includeDomains: [agencyHost(step.domain)],
    timeRange: timeRangeSince(step.since, opts.now),
    maxResults: AGENCY_SEARCH_RESULTS,
    warn: opts.warn,
  });
}
