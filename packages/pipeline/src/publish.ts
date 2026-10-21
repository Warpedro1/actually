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
  /** Claim do alerta (a fala deste segmento). */
  claim_id: string;
  /**
   * Claim da verificação, se não for `claim_id`: na nova tentativa de uma
   * original sem verificação, a verificação vai para a original (a trava por
   * hash a reaproveita nas repetições seguintes).
   */
  verification_claim_id?: string;
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
  /** Passa pelo editor mesmo com HITL desligado (ex.: acusação). */
  force_review?: boolean;
  settings: DebateSettings;
}

export interface PublishResult {
  verification_id: string;
  alert_id: string | null;
  alert_status: AlertStatus | null;
}

export async function publishVerification(store: PipelineStore, input: PublishInput, logger: Logger): Promise<PublishResult> {
  const ver = await store.insertVerification({
    claim_id: input.verification_claim_id ?? input.claim_id,
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
    status: input.force_review ? "pending_review" : alertStatusFor(input.alert, input.settings),
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
 * Status da repetição: o HITL do debate ATUAL vale sempre (a original pode ter
 * sido publicada antes de o editor ligar a aprovação). Original ainda pendente
 * nunca gera repetição publicada; rejeitada (ou retirada) não gera repetição.
 */
export function repeatStatusFor(
  original: Pick<Alert, "status" | "verdict">,
  settings: Pick<DebateSettings, "require_red_approval" | "require_yellow_approval">,
): AlertStatus | null {
  if (original.status === "rejected") return null;
  if (original.status !== "published") return "pending_review";
  return alertStatusFor(original.verdict === "contradito" ? "red" : "yellow", settings);
}

/**
 * Repetição de afirmação que já gerou alerta NESTE debate: novo alerta com
 * is_repeat e a mesma verificação (a UI mostra "Repetido — já verificado às
 * HH:MM"); status por `repeatStatusFor`. Alerta de outro debate nunca é repetido.
 */
export async function publishRepeat(
  store: PipelineStore,
  input: {
    debate_id: string; claim_id: string; claim_text: string; speaker_label: string | null; segment_t_end: number | null;
    original: Alert;
    settings: Pick<DebateSettings, "require_red_approval" | "require_yellow_approval">;
  },
  logger: Logger,
): Promise<{ id: string; status: AlertStatus } | null> {
  const o = input.original;
  if (o.debate_id !== input.debate_id) {
    logger("warn", "repeat_other_debate_skipped", { original_alert_id: o.id, claim_id: input.claim_id });
    return null;
  }
  const status = repeatStatusFor(o, input.settings);
  if (!status) return null;
  return insertAlertSafe(store, {
    debate_id: input.debate_id,
    claim_id: input.claim_id,
    verification_id: o.verification_id,
    verdict: o.verdict,
    status,
    claim_text: input.claim_text,
    summary: o.summary,
    correction: o.correction,
    speaker_label: input.speaker_label,
    is_repeat: true,
    repeat_of: o.id,
    segment_t_end: input.segment_t_end,
  }, logger);
}
