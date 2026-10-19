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
}

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
}

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
