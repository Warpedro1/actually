// Rerank Voyage (rerank-2.5) via fetch.
import { TIMEOUTS_MS, VOYAGE_RERANK_MODEL, VOYAGE_RERANK_URL } from "./config";
import type { UsageMeter } from "./usage";

export interface RerankHit {
  /** Índice no array `documents` de entrada. */
  index: number;
  /** 0–1, maior = mais relevante. */
  relevance_score: number;
}
export type RerankFn = (query: string, documents: string[], topK: number) => Promise<RerankHit[]>;

interface VoyageRerankResponse {
  data: RerankHit[];
  usage?: { total_tokens?: number };
}

export function voyageRerank(apiKey: string, fetchImpl: typeof fetch = fetch, usage?: UsageMeter): RerankFn {
  return async (query, documents, topK) => {
    if (!documents.length) return [];
    const res = await fetchImpl(VOYAGE_RERANK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        documents,
        model: VOYAGE_RERANK_MODEL,
        top_k: Math.min(topK, documents.length),
        truncation: true,
      }),
      signal: AbortSignal.timeout(TIMEOUTS_MS.rerank),
    });
    usage?.ratelimit("voyage", res.headers);
    if (!res.ok) throw new Error(`voyage rerank ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as VoyageRerankResponse;
    usage?.record({ provider: "voyage", model: VOYAGE_RERANK_MODEL, requests: 1, input_tokens: json.usage?.total_tokens ?? 0 });
    return json.data
      .filter((h) => Number.isInteger(h.index) && h.index >= 0 && h.index < documents.length)
      .sort((a, b) => b.relevance_score - a.relevance_score);
  };
}
