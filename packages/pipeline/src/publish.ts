// Gravação: verifications → evidence → alerts. O trigger do banco recusa
// publicar sem evidência verificada; se acontecer é bug nosso — loga alto e
// grava como pending_review (nunca some, nunca publica sem fonte).
import type { Alert, AlertStatus, AlertVerdict, DebateSettings, KbLayer, Verdict } from "@actually/db";
import type { AlertLevel } from "./index";
import { errorFields, type Logger } from "./log";
import { isCheckViolation, type NewAlert, type PipelineStore } from "./store";
import type { EvidenceRecord } from "./types";

export function alertStatusFor(level: AlertLevel, settings: Pick<DebateSettings, "require_red_approval" | "require_yellow_approval">): AlertStatus {
  const needsReview = level === "red" ? settings.require_red_approval : settings.require_yellow_approval;
  return needsReview ? "pending_review" : "published";
}

/** Insere o alerta; se o trigger recusar a publicação, rebaixa para pending_review. */
export async function insertAlertSafe(store: PipelineStore, row: NewAlert, logger: Logger): Promise<{ id: string; status: AlertStatus }> {
  try {
    const { id } = await store.insertAlert(row);
    return { id, status: row.status };
  } catch (err) {
    if (row.status === "published" && isCheckViolation(err)) {
      logger("error", "BUG_publish_without_verified_evidence", {
        verification_id: row.verification_id, claim_id: row.claim_id, ...errorFields(err),
      });
      const { id } = await store.insertAlert({ ...row, status: "pending_review" });
      return { id, status: "pending_review" };
    }
    throw err;
  }
}

export interface PublishInput {
  debate_id: string;
  claim_id: string;
  claim_text: string;
  speaker_label: string | null;
  segment_t_end: number | null;
  verdict: Verdict;
  correction: string;
  summary: string;
  model_confidence: number;
  final_score: number;
  score_components: Record<string, number | string | boolean>;
  layer: KbLayer;
  model: string | null;
  latency_ms: Record<string, number>;
  evidence: EvidenceRecord[];
  alert: AlertLevel | null;
  settings: DebateSettings;
}

export interface PublishResult {
  verification_id: string;
  alert_id: string | null;
  alert_status: AlertStatus | null;
}

export async function publishVerification(store: PipelineStore, input: PublishInput, logger: Logger): Promise<PublishResult> {
  const ver = await store.insertVerification({
    claim_id: input.claim_id,
    verdict: input.verdict,
    correction: input.correction || null,
    model_confidence: input.model_confidence,
    final_score: input.final_score,
    score_components: input.score_components,
    layer: input.layer,
    model: input.model,
    latency_ms: input.latency_ms,
  });
  await store.insertEvidence(
    input.evidence
      .filter((e) => /^https?:\/\//i.test(e.url) && e.quote.trim())
      .map((e) => ({
        verification_id: ver.id,
        evidence_type: e.evidence_type,
        url: e.url,
        source_name: e.source_name,
        source_tier: e.source_tier,
        quote: e.quote,
        quote_verified: e.quote_verified,
        published_at: e.published_at,
      })),
  );
  if (!input.alert) return { verification_id: ver.id, alert_id: null, alert_status: null };

  const verdict: AlertVerdict = input.alert === "red" ? "contradito" : "impreciso";
  const alert = await insertAlertSafe(store, {
    debate_id: input.debate_id,
    claim_id: input.claim_id,
    verification_id: ver.id,
    verdict,
    status: alertStatusFor(input.alert, input.settings),
    claim_text: input.claim_text,
    summary: input.summary || input.correction,
    correction: input.correction,
    speaker_label: input.speaker_label,
    is_repeat: false,
    repeat_of: null,
    segment_t_end: input.segment_t_end,
  }, logger);
  return { verification_id: ver.id, alert_id: alert.id, alert_status: alert.status };
}

/**
 * Repetição de afirmação que já gerou alerta: novo alerta com is_repeat,
 * mesma verificação e mesmo status da original (a UI mostra "Repetido — já
 * verificado às HH:MM"). Original rejeitada pelo editor ⇒ nada.
 */
export async function publishRepeat(
  store: PipelineStore,
  input: { debate_id: string; claim_id: string; claim_text: string; speaker_label: string | null; segment_t_end: number | null; original: Alert },
  logger: Logger,
): Promise<{ id: string; status: AlertStatus } | null> {
  const o = input.original;
  if (o.status === "rejected") return null;
  return insertAlertSafe(store, {
    debate_id: input.debate_id,
    claim_id: input.claim_id,
    verification_id: o.verification_id,
    verdict: o.verdict,
    status: o.status,
    claim_text: input.claim_text,
    summary: o.summary,
    correction: o.correction,
    speaker_label: input.speaker_label,
    is_repeat: true,
    repeat_of: o.id,
    segment_t_end: input.segment_t_end,
  }, logger);
}
