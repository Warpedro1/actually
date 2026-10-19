// L1 — checagens já publicadas (busca híbrida match_factchecks + rerank).
import { lookupSource, tierForUrl } from "@actually/db";
import { RERANK_MIN_RELEVANCE, RERANK_TOP_K, RETRIEVE_COUNT } from "../config";
import type { Logger } from "../log";
import type { RerankFn } from "../rerank";
import type { PipelineStore } from "../store";
import type { EvidenceCandidate } from "../types";
import { rerankFilter } from "./rank";

export async function retrieveFactchecks(
  claimText: string,
  embedding: number[],
  store: PipelineStore,
  rerank: RerankFn,
  logger: Logger,
): Promise<EvidenceCandidate[]> {
  const rows = await store.matchFactchecks(embedding, claimText, RETRIEVE_COUNT.L1);
  const ranked = await rerankFilter(
    claimText,
    rows,
    (r) => `Afirmação checada: ${r.claim_text}\nConclusão: ${r.rating_original}. ${r.quote}`,
    rerank,
    { topK: RERANK_TOP_K.L1, minRelevance: RERANK_MIN_RELEVANCE.L1, layer: "L1", logger },
  );
  return ranked.map(({ item: r, relevance }) => ({
    layer: "L1" as const,
    evidence_type: "factcheck" as const,
    url: r.url,
    source_name: r.source_name || lookupSource(r.url)?.name || r.url,
    source_tier: tierForUrl(r.url),
    published_at: r.published_at,
    title: r.claim_text,
    // texto onde a citação pode estar: trecho-chave + corpo da checagem
    text: [
      `Afirmação checada: ${r.claim_text}`,
      `Classificação: ${r.rating_original}`,
      r.quote,
      r.body ?? "",
    ].filter(Boolean).join("\n"),
    relevance,
    factcheck_verdict: r.verdict,
  }));
}
