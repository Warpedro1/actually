// L3 — documentos de contexto (programas, entrevistas, debates, leis...):
// busca híbrida match_chunks + rerank.
import { RERANK_MIN_RELEVANCE, RERANK_TOP_K, RETRIEVE_COUNT } from "../config";
import type { Logger } from "../log";
import type { RerankFn } from "../rerank";
import type { PipelineStore } from "../store";
import type { EvidenceCandidate } from "../types";
import { rerankFilter } from "./rank";

export async function retrieveDocuments(
  claimText: string,
  embedding: number[],
  store: PipelineStore,
  rerank: RerankFn,
  logger: Logger,
): Promise<EvidenceCandidate[]> {
  // sem filtro de pessoa: o MVP não sabe com segurança quem está falando
  const rows = await store.matchChunks(embedding, claimText, RETRIEVE_COUNT.L3, null);
  const ranked = await rerankFilter(
    claimText,
    rows,
    (r) => `${r.title}\n${r.text}`,
    rerank,
    { topK: RERANK_TOP_K.L3, minRelevance: RERANK_MIN_RELEVANCE.L3, layer: "L3", logger },
  );
  return ranked.map(({ item: r, relevance }) => ({
    layer: "L3" as const,
    evidence_type: "document" as const,
    url: r.url,
    source_name: r.source_name,
    source_tier: r.tier,
    published_at: r.published_at,
    title: r.title,
    text: r.text,
    relevance,
  }));
}
