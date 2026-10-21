// Configuração estática do pipeline. O que muda por debate (thresholds, HITL,
// janela de contexto, similaridade da trava) vive em debates.settings.
import { EMBEDDING_DIM } from "@actually/db";

/** Filtro + extração: roda em todo segmento, precisa ser barato e rápido. */
export const MODEL_EXTRACT = "claude-haiku-5-5";
/** Verificação: roda poucas vezes, precisa de julgamento. */
export const MODEL_VERIFY = "claude-sonnet-5-5";

/**
 * Preço por milhão de tokens (USD), só para o custo ESTIMADO do painel "Uso das
 * APIs" — a cobrança real é a do Console da Anthropic. Haiku 5.5: até 100K
 * tokens de prompt (os nossos são bem menores).
 */
export const ANTHROPIC_PRICES_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};
/** Leitura de cache sai a ~0,1× da entrada; escrita (TTL 5 min) a ~1,25×. */
export const ANTHROPIC_CACHE_READ_FACTOR = 0.1;
export const ANTHROPIC_CACHE_WRITE_FACTOR = 1.25;

export const VOYAGE_EMBED_MODEL = "voyage-3.5";
export const VOYAGE_RERANK_MODEL = "rerank-2.5";
export const VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings";
export const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export { EMBEDDING_DIM };

/** Timeouts por etapa (ms). Estourou → a etapa conta como "sem resultado" (silêncio). */
export const TIMEOUTS_MS = {
  extract: 6_000,
  context: 1_500,
  embed: 2_500,
  dedup: 2_000,
  L1: 2_500,
  L2: 2_000,
  L3: 2_500,
  L4: 7_000,
  rerank: 2_000,
  /** Por tentativa (o SDK faz 1 retry). */
  verify: 15_000,
  /** Teto total da verificação, com retry. */
  verify_total: 20_000,
  publish: 5_000,
  /** Gravação do uso das APIs (depois do trecho; nunca atrasa alerta). */
  usage: 3_000,
} as const;

/**
 * Regras por tipo de fala (score.ts):
 * - max_level: nível máximo do alerta (opinião e previsão nunca são vermelhas);
 * - extra_threshold: soma ao threshold do nível (exige mais certeza);
 * - max_tier: qualquer alerta só com fonte deste nível ou melhor (o nível 4 nunca vale);
 * - red_max_tier: vermelho só com fonte deste nível ou melhor;
 * - force_review: alerta sempre passa pelo editor, com HITL ligado ou não.
 */
export const KIND_RULES = {
  fato: { max_level: "red", extra_threshold: 0, max_tier: 3, red_max_tier: 2, force_review: false },
  estatistica: { max_level: "red", extra_threshold: 0, max_tier: 3, red_max_tier: 2, force_review: false },
  acusacao: { max_level: "red", extra_threshold: 0, max_tier: 2, red_max_tier: 1, force_review: true },
  opiniao_mensuravel: { max_level: "yellow", extra_threshold: 0.1, max_tier: 2, red_max_tier: 2, force_review: false },
  previsao: { max_level: "yellow", extra_threshold: 0.1, max_tier: 2, red_max_tier: 2, force_review: false },
} as const;

/**
 * Fatos de referência (retrieve/reference.ts): até onde o dito ainda "bate".
 * Anos no poder: ±1 ano é arredondamento de fala; até 20% é impreciso; além, contradito.
 * Votos: ±2% bate, até 10% impreciso. Percentual de válidos: ±1 p.p. bate, até 3 p.p. impreciso.
 */
export const REFERENCE_TOLERANCE = {
  years_match: 1,
  years_minor_frac: 0.2,
  votes_match_frac: 0.02,
  votes_minor_frac: 0.1,
  pct_match_pp: 1,
  pct_minor_pp: 3,
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
/**
 * Base "forte" dispensa a web: checagem ou documento com relevância a partir
 * disto (ou indicador com dado). Abaixo, a web (L4) entra como complemento —
 * no ensaio de 21/10, votações do Senado vizinhas do assunto (relevância ≥ 0,5)
 * travavam a web e as afirmações saíam inconclusivas. Calibrar no eval.
 */
export const WEB_SKIP_MIN_RELEVANCE = { L1: 0.75, L3: 0.75 } as const;
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
