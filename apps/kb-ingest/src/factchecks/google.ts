// Google Fact Check Tools API — claims:search (v1alpha1).
// Endpoint confirmado na rede (responde 403 "unregistered callers" sem chave);
// campos conforme o cliente oficial @googleapis/factchecktools: claims[].text,
// claimant, claimDate, claimReview[].{publisher{name,site}, url, title, reviewDate,
// textualRating, languageCode}; paginação por nextPageToken.
import { fetchJson } from "../lib/http";
import { recordUsage } from "../lib/usage";
import type { FactcheckCandidate } from "./normalize";

export const FACTCHECK_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search";

export interface GoogleClaimReview {
  publisher?: { name?: string | null; site?: string | null };
  url?: string | null;
  title?: string | null;
  reviewDate?: string | null;
  textualRating?: string | null;
  languageCode?: string | null;
}
export interface GoogleClaim {
  text?: string | null;
  claimant?: string | null;
  claimDate?: string | null;
  claimReview?: GoogleClaimReview[];
}
export interface GoogleSearchResponse {
  claims?: GoogleClaim[];
  nextPageToken?: string | null;
}

/** Consultas: pessoas + governo + tópicos-guia. */
export const GOOGLE_QUERIES = [
  "Lula",
  "Flávio Bolsonaro",
  "Jair Bolsonaro",
  "governo Lula",
  "governo Bolsonaro",
  "inflação",
  "desemprego",
  "PIB",
  "juros Selic",
  "dívida pública",
  "imposto de renda",
  "isenção imposto de renda",
  "Bolsa Família",
  "programas sociais",
  "armas",
  "segurança pública",
  "corrupção",
  "8 de janeiro",
  "STF",
  "vacina",
  "SUS",
  "desmatamento",
  "Amazônia",
  "educação",
  "política externa",
  "tarifa Estados Unidos",
];

export function googleSearchUrl(params: { query: string; key: string; maxAgeDays?: number; pageToken?: string; pageSize?: number }): string {
  const qs = new URLSearchParams({ query: params.query, languageCode: "pt", pageSize: String(params.pageSize ?? 100), key: params.key });
  if (params.maxAgeDays) qs.set("maxAgeDays", String(params.maxAgeDays));
  if (params.pageToken) qs.set("pageToken", params.pageToken);
  return `${FACTCHECK_URL}?${qs.toString()}`;
}

/** Resposta → candidatos (uma checagem por claimReview em português). Pura. */
export function parseGoogleResponse(res: GoogleSearchResponse): FactcheckCandidate[] {
  const out: FactcheckCandidate[] = [];
  for (const c of res.claims ?? []) {
    for (const r of c.claimReview ?? []) {
      if (!r.url || !/^https?:\/\//i.test(r.url)) continue;
      if (r.languageCode && !/^pt/i.test(r.languageCode)) continue;
      out.push({
        url: r.url,
        sourceName: r.publisher?.name ?? null,
        title: r.title ?? null,
        claimText: c.text ?? null,
        claimant: c.claimant ?? null,
        ratingOriginal: r.textualRating ?? null,
        publishedAt: r.reviewDate ?? c.claimDate ?? null,
      });
    }
  }
  return out;
}

export async function searchGoogle(opts: {
  queries: string[];
  maxAgeDays?: number;
  maxPages: number;
  log: (...a: unknown[]) => void;
}): Promise<FactcheckCandidate[]> {
  const key = process.env.GOOGLE_FACTCHECK_API_KEY;
  if (!key) throw new Error("GOOGLE_FACTCHECK_API_KEY ausente");
  const all: FactcheckCandidate[] = [];
  for (const query of opts.queries) {
    let pageToken: string | undefined;
    let n = 0;
    for (let page = 0; page < opts.maxPages; page++) {
      const res = await fetchJson<GoogleSearchResponse>(googleSearchUrl({ query, key, maxAgeDays: opts.maxAgeDays, pageToken }));
      recordUsage({ provider: "google_factcheck", requests: 1, units: 1 });
      const items = parseGoogleResponse(res);
      all.push(...items);
      n += items.length;
      pageToken = res.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    opts.log(`  google "${query}": ${n} checagens`);
  }
  return all;
}
