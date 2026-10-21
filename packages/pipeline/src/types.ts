// Tipos internos do pipeline. Linhas do banco e retornos de RPC vêm de @actually/db.
import type {
  ClaimNumber, EvidenceType, IndicatorRef, KbLayer, SourceTier, Verdict,
} from "@actually/db";

export const TOPICS = [
  "economia", "impostos", "programas_sociais", "seguranca", "corrupcao_justica",
  "saude", "meio_ambiente", "educacao", "politica_externa", "outro",
] as const;
export type Topic = (typeof TOPICS)[number];

/**
 * Tipo da fala. Promessa e opinião pura saem na extração (não há como medir);
 * opinião mensurável e previsão são julgadas com regras mais duras (só amarelo,
 * limite maior); acusação só no que é fato processual, com revisão humana.
 */
export const CLAIM_KINDS = ["fato", "estatistica", "acusacao", "opiniao_mensuravel", "previsao"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
/** Tipos que o extrator marca para o código descartar. */
export const DROPPED_KINDS = ["promessa", "opiniao"] as const;

/** Afirmação atômica saída da extração (antes de virar linha em `claims`). */
export interface ExtractedClaim {
  text_original: string;
  text_normalized: string;
  topic: Topic;
  kind: ClaimKind;
  /** Opinião mensurável/previsão: o dado ou projeção que mede a fala (consulta da L3/L4). */
  measurable: string | null;
  numbers: ClaimNumber[];
  indicator: IndicatorRef | null;
  time_reference: string | null;
}

/** Resultado determinístico da comparação numérica da camada L2. */
export type ComparisonStatus = "match" | "minor_mismatch" | "mismatch" | "no_data";

export interface IndicatorComparison {
  status: ComparisonStatus;
  /** Veredito que o comparador sustenta (null se no_data). */
  expected_verdict: Verdict | null;
  series_code: string | null;
  claimed: number | null;
  /** Valor oficial mais próximo do afirmado (entre os candidatos: média/último etc.). */
  actual: number | null;
  tolerance: number | null;
  /** Texto da evidência gerado em código — "Série X (fonte): período = valor unidade". */
  evidence_text: string | null;
  reason: string;
}

/** Evidência candidata, de qualquer camada, antes da verificação. */
export interface EvidenceCandidate {
  layer: KbLayer;
  evidence_type: EvidenceType;
  url: string;
  source_name: string;
  source_tier: SourceTier;
  published_at: string | null;
  title: string | null;
  /** Texto completo da fonte — a citação do modelo é conferida contra ele. */
  text: string;
  /** Relevância 0–1 (rerank) ou 1 para L2. */
  relevance: number;
  /** L1: veredito da checagem publicada. */
  factcheck_verdict?: Verdict;
  /** L2: comparação determinística. A citação é o próprio evidence_text (quote_verified=true). */
  comparison?: IndicatorComparison;
}

export interface LayerOutcome {
  layer: KbLayer;
  candidates: EvidenceCandidate[];
  latency_ms: number;
  error?: string;
}

export interface RetrievalResult {
  candidates: EvidenceCandidate[];
  /** Comparação L2 (se a afirmação tinha indicador). */
  comparison: IndicatorComparison | null;
  layers: LayerOutcome[];
  used_web: boolean;
}

/** Saída validada do verificador. */
export interface ModelVerdict {
  verdict: Verdict;
  confidence: number;
  correction: string;
  summary: string;
  citations: { evidence_index: number; quote: string }[];
  /** Por que virou inconclusivo à força (refusal, parse, timeout...). */
  forced_reason: string | null;
}

/** Evidência pronta para gravar / devolver. */
export interface EvidenceRecord {
  layer: KbLayer;
  evidence_type: EvidenceType;
  url: string;
  source_name: string;
  source_tier: SourceTier;
  quote: string;
  quote_verified: boolean;
  published_at: string | null;
  /** Similaridade da checagem da citação. */
  quote_similarity: number;
  factcheck_verdict?: Verdict;
}
