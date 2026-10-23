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
export const CLAIM_KINDS = ["fato", "estatistica", "acusacao", "opiniao_mensuravel"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
/**
 * Tipos que o extrator marca para o código descartar. Previsão saiu dos tipos checáveis por
 * decisão do usuário (23/10): no ensaio completo foram 5 afirmações, todas inconclusivas e
 * nenhum alerta — comparar fala com projeção publicada não sustentava veredito.
 */
export const DROPPED_KINDS = ["promessa", "opiniao", "previsao"] as const;

/**
 * Afirmação sobre fato de referência (conta feita em código):
 * - tempo_no_poder: quanto tempo uma pessoa ou partido ocupou a Presidência
 *   ("o PT governou 20 dos últimos 24 anos" → subject PT, window_years 24, claimed 20);
 * - eleicao: votos ou % de votos válidos de um candidato num turno.
 */
export interface ReferenceRef {
  type: "tempo_no_poder" | "eleicao";
  /** Pessoa ou partido (tempo_no_poder) ou candidato (eleicao), como dito. */
  subject: string;
  /** tempo_no_poder: janela em anos ("dos últimos 24 anos"); null = tempo total. */
  window_years: number | null;
  year: number | null;
  round: number | null;
  claimed_value: number;
  unit: "anos" | "votos" | "%";
  qualifier: "exato" | "cerca_de" | "mais_de" | "menos_de" | "quase";
}

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
  /** Fato de referência (mandatos, eleições), quando a fala é sobre isso. */
  reference: ReferenceRef | null;
  time_reference: string | null;
  /**
   * A afirmação sempre passa pelo editor, qualquer que seja o tipo: hoje, o fato pressuposto
   * por uma pergunta ("caiu o roubo de celular?"), que é mais arriscado que uma fala direta.
   */
  force_review?: boolean;
  /** Auditoria: tipo que o modelo deu e a regra em código que o mudou (se houve). */
  kind_model?: string;
  kind_rule?: string;
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
  /**
   * Evidência da base com relevância baixa, que entrou junto com a web (base fraca), ou
   * documento que a base aprendeu da própria busca web (origin 'web'): pode ser citada, mas
   * não conta como camada independente, não tira o acréscimo da web e não deixa a base "forte".
   */
  weak?: boolean;
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
  /**
   * Candidatos que a L4 trouxe (já filtrados: nível ≤ 2, acentos, rerank ≥ mínimo),
   * MESMO quando a base foi forte e a web não entrou na verificação — é o que a base
   * aprende (fila kb_web_finds). Nunca rejeita (a camada tem timeout); null = sem L4.
   */
  web_found: Promise<EvidenceCandidate[]> | null;
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
  /** Ver EvidenceCandidate.weak. */
  weak?: boolean;
}
