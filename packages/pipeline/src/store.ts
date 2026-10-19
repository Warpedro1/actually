// Acesso ao banco usado pelo pipeline. A interface é estreita de propósito:
// os testes trocam a implementação Supabase por um mock em memória.
import {
  toPgVector,
  type Alert, type AlertStatus, type AlertVerdict, type ChunkMatch, type ClaimNumber, type Debate,
  type FactcheckMatch, type IndicatorMatch, type IndicatorRef, type IndicatorValue, type KbLayer,
  type Segment, type Verdict, type VerifiedClaimMatch, type serviceClient,
} from "@actually/db";
import type { EvidenceType, SourceTier } from "@actually/db";

/** Erro do banco com o código SQLSTATE preservado (ex.: 23505, 23514). */
export class DbError extends Error {
  constructor(message: string, public readonly code: string | undefined) {
    super(message);
    this.name = "DbError";
  }
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_CHECK_VIOLATION = "23514";

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === PG_UNIQUE_VIOLATION;
}
export function isCheckViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === PG_CHECK_VIOLATION;
}

/** Afirmação original já registrada no debate com o mesmo hash. */
export interface HashMatch {
  claim_id: string;
  /** null = original ainda sem verificação (em andamento ou sem evidência). */
  verification_id: string | null;
  verdict: Verdict | null;
  alert_id: string | null;
  alert_status: AlertStatus | null;
  verified_at: string | null;
  /**
   * created_at da tentativa mais recente com este hash no debate (a original ou
   * uma repetição dela). Diz se ainda há uma verificação em andamento.
   */
  last_attempt_at: string | null;
}

export interface NewClaim {
  debate_id: string;
  segment_id: number;
  speaker_label: string | null;
  text_original: string;
  text_normalized: string;
  claim_hash: string;
  numbers: ClaimNumber[];
  topic: string | null;
  indicator: IndicatorRef | null;
  embedding: number[] | null;
  duplicate_of: string | null;
}

export interface NewVerification {
  claim_id: string;
  verdict: Verdict;
  correction: string | null;
  model_confidence: number;
  final_score: number;
  score_components: Record<string, number | string | boolean>;
  layer: KbLayer;
  model: string | null;
  latency_ms: Record<string, number>;
}

export interface NewEvidence {
  verification_id: string;
  evidence_type: EvidenceType;
  url: string;
  source_name: string;
  source_tier: SourceTier;
  quote: string;
  quote_verified: boolean;
  published_at: string | null;
}

export interface NewAlert {
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
}

export interface PipelineStore {
  getSegment(id: number): Promise<{ segment: Segment; debate: Debate } | null>;
  /** Segmentos do debate capturados na janela [capturedAt - windowS, capturedAt), em ordem. */
  getContext(debateId: string, capturedAt: string, windowS: number, excludeId: number): Promise<Segment[]>;
  findClaimByHash(debateId: string, hash: string): Promise<HashMatch | null>;
  matchVerifiedClaims(debateId: string, embedding: number[], minSimilarity: number, count: number): Promise<VerifiedClaimMatch[]>;
  getAlert(id: string): Promise<Alert | null>;
  /** Lança DbError com code 23505 se outra invocação gravou o mesmo hash antes. */
  insertClaim(row: NewClaim): Promise<{ id: string }>;
  insertVerification(row: NewVerification): Promise<{ id: string; created_at: string }>;
  insertEvidence(rows: NewEvidence[]): Promise<void>;
  /** Lança DbError com code 23514 se o trigger recusar publicar sem evidência verificada. */
  insertAlert(row: NewAlert): Promise<{ id: string }>;
  matchFactchecks(embedding: number[], text: string, count: number): Promise<FactcheckMatch[]>;
  matchChunks(embedding: number[], text: string, count: number, person: string | null): Promise<ChunkMatch[]>;
  findIndicator(q: string, count: number): Promise<IndicatorMatch[]>;
  indicatorValues(seriesCode: string): Promise<IndicatorValue[]>;
}

// ---------------------------------------------------------------------------
// Implementação Supabase (service role)
// ---------------------------------------------------------------------------
type Sb = ReturnType<typeof serviceClient>;
type PgErr = { message: string; code?: string } | null;

function check<T>(res: { data: T; error: PgErr }, what: string): T {
  if (res.error) throw new DbError(`${what}: ${res.error.message}`, res.error.code);
  return res.data;
}

function checkOne<T>(res: { data: T; error: PgErr }, what: string): NonNullable<T> {
  const data = check(res, what);
  if (data == null) throw new DbError(`${what}: nenhuma linha retornada`, undefined);
  return data;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

export function supabaseStore(sb: Sb): PipelineStore {
  return {
    async getSegment(id) {
      const seg = check(await sb.from("segments").select("*").eq("id", id).maybeSingle(), "getSegment");
      if (!seg) return null;
      const debate = check(
        await sb.from("debates").select("*").eq("id", seg.debate_id).single(),
        "getSegment/debate",
      );
      return {
        segment: { ...seg, t_start: num(seg.t_start), t_end: num(seg.t_end) } as Segment,
        debate: debate as Debate,
      };
    },

    async getContext(debateId, capturedAt, windowS, excludeId) {
      const from = new Date(Date.parse(capturedAt) - windowS * 1000).toISOString();
      const rows = check(
        await sb.from("segments").select("*")
          .eq("debate_id", debateId)
          .gte("captured_at", from)
          .lt("captured_at", capturedAt)
          .neq("id", excludeId)
          .order("captured_at", { ascending: true })
          .limit(80),
        "getContext",
      );
      return (rows ?? []) as Segment[];
    },

    async findClaimByHash(debateId, hash) {
      const [orig, latest] = await Promise.all([
        sb.from("claims").select("id")
          .eq("debate_id", debateId).eq("claim_hash", hash).is("duplicate_of", null)
          .limit(1).maybeSingle(),
        sb.from("claims").select("created_at")
          .eq("debate_id", debateId).eq("claim_hash", hash)
          .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const claim = check(orig, "findClaimByHash");
      if (!claim) return null;
      const last_attempt_at = (check(latest, "findClaimByHash/latest") as { created_at: string } | null)?.created_at ?? null;
      const ver = check(
        await sb.from("verifications").select("id, verdict, created_at")
          .eq("claim_id", claim.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        "findClaimByHash/verification",
      );
      if (!ver) {
        return { claim_id: claim.id, verification_id: null, verdict: null, alert_id: null, alert_status: null, verified_at: null, last_attempt_at };
      }
      const alert = check(
        await sb.from("alerts").select("id, status")
          .eq("verification_id", ver.id).eq("is_repeat", false).limit(1).maybeSingle(),
        "findClaimByHash/alert",
      );
      return {
        claim_id: claim.id,
        verification_id: ver.id,
        verdict: ver.verdict as Verdict,
        alert_id: alert?.id ?? null,
        alert_status: (alert?.status as AlertStatus | undefined) ?? null,
        verified_at: ver.created_at,
        last_attempt_at,
      };
    },

    async matchVerifiedClaims(debateId, embedding, minSimilarity, count) {
      const rows = check(
        await sb.rpc("match_verified_claims", {
          p_debate_id: debateId,
          query_embedding: toPgVector(embedding),
          min_similarity: minSimilarity,
          match_count: count,
        }),
        "match_verified_claims",
      );
      return (rows ?? []) as VerifiedClaimMatch[];
    },

    async getAlert(id) {
      return check(await sb.from("alerts").select("*").eq("id", id).maybeSingle(), "getAlert") as Alert | null;
    },

    async insertClaim(row) {
      const data = checkOne(
        await sb.from("claims")
          .insert({ ...row, embedding: row.embedding ? toPgVector(row.embedding) : null })
          .select("id").single(),
        "insertClaim",
      );
      return { id: data.id };
    },

    async insertVerification(row) {
      const data = checkOne(
        await sb.from("verifications").insert(row).select("id, created_at").single(),
        "insertVerification",
      );
      return { id: data.id, created_at: data.created_at };
    },

    async insertEvidence(rows) {
      if (!rows.length) return;
      check(await sb.from("evidence").insert(rows), "insertEvidence");
    },

    async insertAlert(row) {
      const data = checkOne(await sb.from("alerts").insert(row).select("id").single(), "insertAlert");
      return { id: data.id };
    },

    async matchFactchecks(embedding, text, count) {
      const rows = check(
        await sb.rpc("match_factchecks", { query_embedding: toPgVector(embedding), query_text: text, match_count: count }),
        "match_factchecks",
      );
      return (rows ?? []) as FactcheckMatch[];
    },

    async matchChunks(embedding, text, count, person) {
      const rows = check(
        await sb.rpc("match_chunks", {
          query_embedding: toPgVector(embedding), query_text: text, match_count: count, filter_person: person,
        }),
        "match_chunks",
      );
      return (rows ?? []) as ChunkMatch[];
    },

    async findIndicator(q, count) {
      const rows = check(await sb.rpc("find_indicator_v2", { q, match_count: count }), "find_indicator_v2");
      return ((rows ?? []) as IndicatorMatch[]).map((r) => ({ ...r, score: num(r.score) }));
    },

    async indicatorValues(seriesCode) {
      const rows = check(
        await sb.from("indicator_values").select("*").eq("series_code", seriesCode)
          .order("period_start", { ascending: true }),
        "indicatorValues",
      );
      return ((rows ?? []) as IndicatorValue[]).map((r) => ({ ...r, value: num(r.value) }));
    },
  };
}
