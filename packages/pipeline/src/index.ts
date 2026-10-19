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

export type AlertLevel = "red" | "yellow";

/** Resultado de checar uma afirmação sem gravar nada (usado pelo eval e por testes). */
export interface ClaimDecision {
  /** Afirmação atômica, já com contexto resolvido. */
  claim: string;
  verdict: import("@actually/db").Verdict;
  final_score: number;
  /** null = silêncio (abaixo do threshold, regra dura ou não checável). */
  alert: AlertLevel | null;
  /** Por que ficou em silêncio, quando ficou. */
  silence_reason: string | null;
  layer: import("@actually/db").KbLayer | null;
  correction: string | null;
  evidence: {
    url: string;
    source_name: string;
    source_tier: import("@actually/db").SourceTier;
    quote: string;
    quote_verified: boolean;
  }[];
  latency_ms: Record<string, number>;
}

/**
 * Modo seco: roda filtro → extração → retrieval → verificação → score sobre um
 * texto, lendo a base de conhecimento mas sem escrever nada. Sem trava de
 * repetição (não há debate). `context` é a transcrição anterior (até ~60 s).
 */
export async function evaluateText(
  text: string,
  context: string,
  opts?: { settings?: Partial<import("@actually/db").DebateSettings> },
): Promise<ClaimDecision[]> {
  void opts;
  throw new Error(`evaluateText(${text.length}, ${context.length}): não implementado`);
}
