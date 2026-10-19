// Contrato público do pipeline. A implementação vive nos módulos irmãos
// (filter, extract, dedup, retrieve/*, verify, quoteCheck, score, publish).

export interface PipelineResult {
  segment_id: number;
  claims: number;
  /** Alertas criados (published + pending_review), incluindo repetições. */
  alerts: number;
  latency_ms: Record<string, number>;
}

/**
 * Processa um segmento já gravado em `segments`: filtra, extrai afirmações,
 * aplica a trava de repetição, recupera evidências (L1–L4), verifica, pontua
 * e grava claims/verifications/evidence/alerts. Nunca lança por falha de
 * uma afirmação isolada — registra e segue (silêncio é o modo seguro).
 */
export async function runPipeline(segmentId: number): Promise<PipelineResult> {
  throw new Error(`runPipeline(${segmentId}): não implementado`);
}
