// Tipos espelhando supabase/migrations/*_init.sql.
// Mudou o schema? Atualize aqui no mesmo commit.

export type Verdict = "contradito" | "impreciso" | "confirmado" | "inconclusivo";
export type AlertVerdict = Extract<Verdict, "contradito" | "impreciso">;
export type AlertStatus = "pending_review" | "published" | "rejected";
export type EvidenceType = "factcheck" | "indicator" | "document" | "web";
export type KbLayer = "L1" | "L2" | "L3" | "L4";
export type CaptureSource = "youtube" | "device" | "file";
export type CaptureRole = "primary" | "standby";
export type SourceTier = 1 | 2 | 3 | 4;

export interface DebateSettings {
  /** Vermelhos entram como pending_review e só saem com aprovação do editor. */
  require_red_approval: boolean;
  /** Idem para amarelos. */
  require_yellow_approval: boolean;
  /** Score mínimo para emitir vermelho (contradito). */
  t_red: number;
  /** Score mínimo para emitir amarelo (impreciso). */
  t_yellow: number;
  /** Somado ao threshold quando a melhor evidência veio da web (L4). */
  web_penalty: number;
  /**
   * Busca na web (L4, Tavily). false = a base (L1–L3) é a única fonte e a Tavily não é
   * chamada. Sem TAVILY_API_KEY no servidor a L4 fica desligada de qualquer jeito.
   */
  web_search: boolean;
  /** Mostra o nome do candidato quando o speaker estiver mapeado. */
  show_attribution: boolean;
  /** Similaridade mínima para a trava de repetição. */
  dedup_similarity: number;
  /** Janela de contexto (s) passada para a extração. */
  context_window_s: number;
  /** Sem heartbeat do agente ativo por esse tempo → failover. */
  failover_after_s: number;
}

export const DEFAULT_SETTINGS: DebateSettings = {
  require_red_approval: true,
  require_yellow_approval: false,
  t_red: 0.85,
  t_yellow: 0.75,
  web_penalty: 0.05,
  web_search: true,
  show_attribution: false,
  dedup_similarity: 0.92,
  context_window_s: 60,
  failover_after_s: 10,
};

export function resolveSettings(raw: Partial<DebateSettings> | null | undefined): DebateSettings {
  return { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
}

export interface Debate {
  id: string;
  slug: string;
  title: string;
  youtube_url: string | null;
  status: "scheduled" | "live" | "ended";
  settings: Partial<DebateSettings>;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  /** Horário previsto de início (o /admin usa para sugerir o start_at da captura). */
  scheduled_at: string | null;
  /**
   * Debate de teste (migration 20261020000009): só editores veem (RLS) e os
   * vereditos dele não são reaproveitados por outros debates na trava de repetição.
   */
  is_test: boolean;
  /**
   * Observação do editor exibida na página pública do debate (migration
   * 20261023000016, até 500 caracteres). Ex.: "a checagem não foi rodada ao vivo".
   */
  public_note: string | null;
  /**
   * Procedência da checagem, declarada pelo editor (migration 20261023000016).
   * Não é derivável dos dados: `started_at` fica nulo se o debate não passou por
   * "ao vivo", `ended_at` é a hora do clique, e com `source = 'file'` o relógio
   * do segmento é o do replay. Nulo = não informado; a página não afirma nada.
   */
  check_mode: CheckMode | null;
}

/** live: checado ao vivo · post: publicado depois do debate · mixed: parte e parte. */
export type CheckMode = "live" | "post" | "mixed";

export interface CaptureAgent {
  id: string;
  debate_id: string;
  name: string;
  source: CaptureSource;
  role: CaptureRole;
  active: boolean;
  last_heartbeat: string | null;
  created_at: string;
}

export interface Segment {
  id: number;
  debate_id: string;
  agent_id: string;
  seq: number;
  speaker_label: string | null;
  text: string;
  t_start: number;
  t_end: number;
  captured_at: string;
  received_at: string;
}

/** Número extraído de uma afirmação, usado na trava de repetição e no L2. */
export interface ClaimNumber {
  value: number;
  unit: string | null;
  /** Texto original, ex.: "quase 10 milhões". */
  raw: string;
}

/** Referência estruturada a um indicador (camada L2). */
export interface IndicatorRef {
  /** Nome livre dito na fala, ex.: "desemprego". */
  query: string;
  /** Período ISO: "2023", "2023-T4", "2023-12", ou intervalo "2019..2022". */
  period: string | null;
  /** Valor afirmado na fala. */
  claimed_value: number | null;
  unit: string | null;
  /** Tipo de afirmação sobre o valor. */
  kind: "level" | "change_abs" | "change_pct" | "max" | "min";
}

/** Fatos de referência (migration 0012): mandatos presidenciais, com a conta feita em código. */
export interface RefMandate {
  id: string;
  pessoa: string;
  partido: string;
  inicio: string;
  /** null = em curso. */
  fim: string | null;
  papel: "titular" | "interino";
  fonte_nome: string;
  fonte_url: string;
  trecho: string;
  /** Como a linha foi conferida (auditoria). */
  conferencia?: string;
  notas: string | null;
}

/** Resultado oficial (TSE) de um candidato numa eleição presidencial. */
export interface RefElection {
  id: string;
  ano: number;
  turno: number;
  candidato: string;
  partido: string;
  votos: number;
  pct_validos: number;
  eleito: boolean;
  fonte_nome: string;
  fonte_url: string;
  trecho: string;
  /** Como a linha foi conferida (auditoria). */
  conferencia?: string;
}

// "previsao" fica na lista porque o banco já tem linhas assim (ensaio de 18/10) e o check da
// migration 0011 continua aceitando; o pipeline não extrai mais esse tipo desde 23/10.
export type ClaimKindDb = "fato" | "estatistica" | "acusacao" | "opiniao_mensuravel" | "previsao";

export interface Claim {
  id: string;
  debate_id: string;
  segment_id: number;
  speaker_label: string | null;
  text_original: string;
  text_normalized: string;
  claim_hash: string;
  numbers: ClaimNumber[];
  topic: string | null;
  /** fato | estatistica | acusacao | opiniao_mensuravel | previsao (migration 0011). */
  kind: ClaimKindDb;
  /** Opinião mensurável: o dado que mede a fala. */
  measurable: string | null;
  indicator: IndicatorRef | null;
  embedding: number[] | string | null;
  duplicate_of: string | null;
  created_at: string;
}

export interface Verification {
  id: string;
  claim_id: string;
  verdict: Verdict;
  correction: string | null;
  model_confidence: number;
  final_score: number;
  score_components: Record<string, number | string | boolean>;
  layer: KbLayer;
  model: string | null;
  latency_ms: Record<string, number>;
  created_at: string;
}

export interface Evidence {
  id: string;
  verification_id: string;
  evidence_type: EvidenceType;
  url: string;
  source_name: string;
  source_tier: SourceTier;
  quote: string;
  quote_verified: boolean;
  published_at: string | null;
  created_at: string;
}

export interface Alert {
  id: string;
  debate_id: string;
  claim_id: string;
  verification_id: string;
  verdict: AlertVerdict;
  status: AlertStatus;
  claim_text: string;
  summary: string;
  correction: string;
  speaker_label: string | null;
  is_repeat: boolean;
  repeat_of: string | null;
  segment_t_end: number | null;
  created_at: string;
  published_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reject_reason: string | null;
}

/** Alerta + evidências, como a UI consome (GET /api/alerts e Realtime + fetch). */
export interface AlertWithEvidence extends Alert {
  evidence: Pick<Evidence, "url" | "source_name" | "source_tier" | "quote" | "evidence_type" | "published_at">[];
  /** Preenchido só se settings.show_attribution e o speaker estiver mapeado. */
  person: string | null;
}

/** Sinal público de retirada (migration 20261019000004): o /ao-vivo troca o card por um aviso. */
export interface AlertRetraction {
  alert_id: string;
  debate_id: string;
  retracted_at: string;
}

export interface SpeakerMap {
  debate_id: string;
  speaker_label: string;
  person: string;
  confirmed_by: string | null;
  updated_at: string;
}

export interface SourceTierRow {
  domain: string;
  name: string;
  tier: SourceTier;
  kind: "oficial" | "checagem" | "imprensa" | "academico" | "campanha" | "outro";
}

export interface KbFactcheck {
  id: string;
  source_name: string;
  url: string;
  claim_text: string;
  rating_original: string;
  verdict: Verdict;
  person: string | null;
  topic: string | null;
  quote: string;
  body: string | null;
  published_at: string | null;
  /** 'web' = veio da busca web durante uma checagem (migration 0014); null = carga. */
  origin?: string | null;
}

/**
 * Como a série se agrega num período mais longo que a sua periodicidade (coluna
 * indicator_series.aggregation, migration 20261019000007):
 * - "sum": fluxo (saldo do Caged, PIB nominal trimestral) — ano/trimestre = soma, só com o período completo;
 * - "mean_or_last": taxa com média reconhecida (desocupação, Selic, câmbio) — média do período completo ou último ponto;
 * - "last": estoque (dívida % PIB) — ponto do fim do período;
 * - "accum_12m": acumulado em 12 meses (IPCA 12m, primário 12m) — ano civil = valor de dezembro; trimestre não;
 * - "none": não agrega (variação mensal do IPCA, variação trimestral do PIB, séries anuais) — só o período exato.
 */
export type IndicatorAggregation = "sum" | "mean_or_last" | "last" | "accum_12m" | "none";
/** Mesmos valores do check da coluna indicator_series.aggregation. */
export const INDICATOR_AGGREGATIONS: readonly IndicatorAggregation[] = ["sum", "mean_or_last", "last", "accum_12m", "none"];

export interface IndicatorSeries {
  code: string;
  name: string;
  aliases: string[];
  unit: string;
  periodicity: "monthly" | "quarterly" | "annual" | "moving_quarter";
  /** null = não declarada (linha anterior à coluna, ainda sem `kb-ingest indicators`): a L2 não compara. */
  aggregation: IndicatorAggregation | null;
  source_name: string;
  source_url: string;
  tier: SourceTier;
  notes: string | null;
}

export interface IndicatorValue {
  series_code: string;
  period_start: string; // YYYY-MM-DD
  period_end: string;
  value: number;
  released_at: string | null;
}

export type DocType =
  | "programa" | "entrevista" | "discurso" | "debate" | "lei" | "votacao" | "noticia" | "dado" | "outro";

export interface KbDocument {
  id: string;
  url: string;
  title: string;
  doc_type: DocType;
  person: string | null;
  source_name: string;
  tier: SourceTier;
  published_at: string | null;
  topics: string[];
  body: string;
  /** 'web' = veio da busca web durante uma checagem (migration 0014); null = carga. */
  origin?: string | null;
}

/**
 * Fila "a base aprende com a web" (migration 0014): página que a L4 trouxe durante uma
 * checagem. A carga (etapa web-finds) a transforma em checagem (L1) ou documento (L3).
 */
export interface KbWebFind {
  id: string;
  url: string;
  title: string;
  text: string;
  source_name: string;
  tier: 1 | 2;
  published_at: string | null;
  query: string | null;
  debate_id: string | null;
  found_at: string;
  status: "pending" | "processing" | "done" | "skipped" | "failed";
  claimed_at: string | null;
  processed_at: string | null;
  note: string | null;
}

/** O que o pipeline grava na fila (o resto tem padrão no banco). */
export type KbWebFindInsert = Pick<KbWebFind, "url" | "title" | "text" | "source_name" | "tier" | "published_at" | "query" | "debate_id">;

export interface KbChunk {
  id: number;
  document_id: string;
  chunk_index: number;
  text: string;
}

// Retornos das RPCs -----------------------------------------------------------

export interface FactcheckMatch {
  id: string; source_name: string; url: string; claim_text: string; rating_original: string;
  verdict: Verdict; person: string | null; quote: string; body: string | null;
  published_at: string | null; similarity: number; rrf_score: number;
}

export interface ChunkMatch {
  chunk_id: number; document_id: string; url: string; title: string; doc_type: DocType;
  person: string | null; source_name: string; tier: SourceTier; published_at: string | null;
  text: string; similarity: number; rrf_score: number;
  /** kb_documents.origin (lido à parte; a RPC não devolve): 'web' = veio da busca web. */
  origin?: string | null;
}

export interface VerifiedClaimMatch {
  claim_id: string; debate_id: string; text_normalized: string; numbers: ClaimNumber[];
  indicator: IndicatorRef | null; verification_id: string; verdict: Verdict;
  alert_id: string | null; alert_status: AlertStatus | null; verified_at: string; similarity: number;
}

export interface IndicatorMatch {
  code: string; name: string; unit: string; periodicity: IndicatorSeries["periodicity"];
  aggregation: IndicatorSeries["aggregation"];
  source_name: string; source_url: string; tier: SourceTier; score: number;
}

/** Dimensão dos embeddings (Voyage voyage-3.5). Mudou o modelo? Mude a migration também. */
export const EMBEDDING_DIM = 1024;

// Controle remoto da captura ------------------------------------------------

/** Estado desejado de uma máquina de captura, definido no /admin. */
export interface MachineDesired {
  state: "running" | "stopped";
  debate_slug?: string;
  source?: CaptureSource;
  /** URL da live (source=youtube) ou caminho do arquivo (source=file). */
  url?: string;
  /** Especificação do dispositivo de áudio (source=device). */
  device?: string;
  role?: CaptureRole;
  /** ISO-8601. Com state=running, o daemon só inicia a partir deste horário. */
  start_at?: string;
  /** ISO-8601. Para sozinho neste horário (segurança contra esquecer ligado). */
  stop_at?: string;
}

/** Estado reportado pelo daemon a cada poll. */
export interface MachineReported {
  state: "idle" | "waiting_start" | "starting" | "running" | "stopping" | "error";
  agent_id?: string | null;
  /** Se este agente é o ativo do debate (heartbeat). */
  active?: boolean;
  debate_slug?: string | null;
  source?: CaptureSource | null;
  last_segment_at?: string | null;
  segments_sent?: number;
  /** dBFS médio dos últimos segundos; ~-90 = silêncio. */
  audio_level_db?: number | null;
  reconnects?: number;
  error?: string | null;
  /** Últimas linhas de log (máx. ~20) para diagnóstico remoto. */
  log_tail?: string[];
}

export interface CaptureMachine {
  id: string;
  name: string;
  platform: string | null;
  version: string | null;
  desired: MachineDesired;
  reported: Partial<MachineReported>;
  last_seen: string | null;
  desired_updated_at: string;
  desired_updated_by: string | null;
  created_at: string;
}

// Carga da base pelo /admin (migration 20261020000008) ----------------------

export type KbJobStatus = "queued" | "running" | "done" | "canceled";

export interface KbLogLine {
  t: string;
  level: "info" | "warn" | "error";
  msg: string;
}

/** Etapa da fila (forma completa em apps/kb-ingest/src/jobs/steps.ts). */
export interface KbStepJson {
  kind: string;
  [k: string]: unknown;
}

export interface KbJob {
  id: string;
  preset: string;
  title: string;
  params: Record<string, unknown>;
  status: KbJobStatus;
  /** Etapas pendentes; a primeira é a próxima. */
  steps: KbStepJson[];
  /** Coluna gerada: tamanho de `steps`. */
  steps_pending: number;
  /** Etapa em execução (volta para a fila se o lease vencer). */
  current: KbStepJson | null;
  current_attempts: number;
  steps_done: number;
  steps_failed: number;
  log: KbLogLine[];
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  lease_owner: string | null;
  lease_until: string | null;
}

/** Uma passada da captura num debate (um agente), para escolher o que reprocessar (GET /api/kb/replay). */
export interface ReplayPass {
  agent_id: string;
  name: string;
  segments: number;
  /** Do primeiro t_start ao último t_end, em segundos (relógio do agente). */
  duration_s: number;
  first_at: string;
  last_at: string;
}

/** Resposta de POST /api/kb/replay. */
export interface ReplayCreated {
  job_id: string;
  debate: { id: string; slug: string; title: string };
  segments: number;
}

/** Retorno da RPC kb_counts() (só service role): quanto a base cobre. */
export interface KbCounts {
  source_tiers: number;
  kb_factchecks: number;
  kb_factchecks_sem_embedding: number;
  ultima_checagem: string | null;
  checagens_por_veredito: Partial<Record<Verdict, number>>;
  indicator_series: number;
  indicator_values: number;
  series: { code: string; name: string; aggregation: IndicatorAggregation | null; values: number; last: string | null }[];
  kb_documents: number;
  documentos_por_tipo: Partial<Record<DocType, number>>;
  kb_chunks: number;
  kb_chunks_sem_embedding: number;
}

// Uso das APIs externas (migration 20261021000010) ----------------------------

/** Provedores contados pelo próprio sistema (pipeline e carga da base). */
export type ApiProvider = "anthropic" | "voyage" | "tavily" | "google_factcheck" | "apify";

/** Uma linha para `api_usage_add` (somada na hora corrente). */
export interface ApiUsageRow {
  provider: ApiProvider;
  model?: string;
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  /** Unidade do provedor: créditos da Tavily, runs do Apify… */
  units?: number;
  cost_usd?: number;
}

export type ApiUsageWindow = "hora" | "hoje" | "24h" | "mes";

/** Retorno de `api_usage_summary()`. */
export interface ApiUsageSummary {
  usage: {
    provider: string;
    model: string;
    janela: ApiUsageWindow;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    units: number;
    cost_usd: number;
  }[];
  /** Último retrato dos cabeçalhos de limite por provedor. */
  ratelimits: Record<string, { headers: Record<string, string>; observed_at: string }>;
}
