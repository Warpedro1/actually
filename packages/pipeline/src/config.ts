// Configuração estática do pipeline. O que muda por debate (thresholds, HITL,
// janela de contexto, similaridade da trava) vive em debates.settings.
import { EMBEDDING_DIM } from "@actually/db";

/** Filtro + extração: roda em todo segmento, precisa ser barato e rápido. */
export const MODEL_EXTRACT = "claude-haiku-5-5";
/** Verificação: roda poucas vezes, precisa de julgamento. */
export const MODEL_VERIFY = "claude-sonnet-5-5";

export const VOYAGE_EMBED_MODEL = "voyage-3.5";
export const VOYAGE_RERANK_MODEL = "rerank-2.5";
export const VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings";
export const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export { EMBEDDING_DIM };

/** Timeouts por etapa (ms). Estourou → a etapa conta como "sem resultado" (silêncio). */
export const TIMEOUTS_MS = {
  extract: 6_000,
  embed: 2_500,
  dedup: 2_000,
  L1: 2_500,
  L2: 2_000,
  L3: 2_500,
  L4: 7_000,
  rerank: 2_000,
  verify: 15_000,
  publish: 5_000,
} as const;

/** Quantos candidatos cada RPC devolve antes do rerank. */
export const RETRIEVE_COUNT = { L1: 8, L3: 10, L4: 6 } as const;
/** Quantos sobrevivem ao rerank por camada. */
export const RERANK_TOP_K = { L1: 3, L3: 3, L4: 3 } as const;
/**
 * Relevância mínima (rerank-2.5, 0–1) para a evidência contar como "relevante".
 * Calibrar no eval; L1 é mais exigente porque checagem é sobre afirmação específica.
 */
export const RERANK_MIN_RELEVANCE = { L1: 0.6, L3: 0.5, L4: 0.5 } as const;
/** Sem rerank (falhou/estourou): só aceita candidato com similaridade vetorial alta. */
export const FALLBACK_MIN_SIMILARITY = 0.8;
/** Similaridade (pg_trgm) mínima para aceitar a série encontrada por find_indicator. */
export const INDICATOR_MIN_SCORE = 0.45;

/** Máximo de evidências passadas ao verificador. */
export const MAX_EVIDENCE_FOR_VERIFY = 8;
/** Caracteres de cada evidência mostrados ao modelo (a checagem da citação usa o texto inteiro). */
export const EVIDENCE_CHARS_FOR_VERIFY = 3_000;
/** Limite do resumo exibido no alerta. */
export const SUMMARY_MAX_CHARS = 140;
/** Similaridade mínima (Levenshtein) para aceitar citação aproximada. */
export const QUOTE_MIN_SIMILARITY = 0.9;
/** Citação com menos que isso (normalizada) não prova nada. */
export const QUOTE_MIN_CHARS = 12;
