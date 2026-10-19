// TRAVA DE REPETIÇÃO: afirmação já verificada não é reprocessada.
// (1) mesmo claim_hash no debate; (2) match_verified_claims com similaridade
// ≥ dedup_similarity E mesmos números/período/polaridade. Corrida entre
// invocações paralelas: o índice único claims_unique_hash (23505) decide.
// A trava só vale dentro do debate (metodologia: "já verificada neste debate"):
// afirmação de outro debate (ensaio, debate anterior) é verificada de novo.
import type { AlertStatus, DebateSettings, Segment } from "@actually/db";
import { TIMEOUTS_MS } from "./config";
import type { PipelineDeps } from "./deps";
import { errorFields, withTimeout } from "./log";
import { sameFacts } from "./normalize";
import { publishRepeat } from "./publish";
import { isUniqueViolation, type HashMatch, type NewClaim } from "./store";
import type { ExtractedClaim } from "./types";

export type DedupOutcome =
  /**
   * Seguir para a verificação. `retry_of`: a original (mesmo hash) nunca teve
   * verificação concluída (erro, timeout, sem evidência) — esta claim é gravada
   * como duplicata dela, mas é verificada de novo.
   */
  | { kind: "new"; claim_id: string; retry_of?: string }
  | {
      kind: "duplicate";
      claim_id: string;
      original_claim_id: string;
      via: "hash" | "similarity" | "race";
      /** Verificação reaproveitada (null se a original ainda não terminou / não teve evidência). */
      verification_id: string | null;
      verified_at: string | null;
      repeat_alert: { id: string; status: AlertStatus } | null;
    };

interface Original {
  claim_id: string;
  verification_id: string | null;
  verified_at: string | null;
  alert_id: string | null;
  alert_status: AlertStatus | null;
}

/**
 * Original sem verificação pode estar com a verificação em andamento até este
 * prazo depois de gravada (L1–L3 + L4 + verificação com retry + publicação, com
 * folga). Dentro dele a repetição fica em silêncio (o alerta da original vem);
 * depois dele a original falhou (erro, timeout, sem evidência) e a repetição é
 * verificada de novo.
 */
export const ORIGINAL_IN_PROGRESS_MS =
  TIMEOUTS_MS.L3 + TIMEOUTS_MS.L4 + TIMEOUTS_MS.verify_total + TIMEOUTS_MS.publish + 5_000;

/**
 * `created_at` da original, quando o store informa (HashMatch ainda não traz;
 * sem ele, original sem verificação é sempre verificada de novo).
 */
type HashOriginal = HashMatch & { created_at?: string | null };

/** A original (por hash) já tem verificação, ou ainda pode estar sendo verificada. */
function settledOrInProgress(deps: PipelineDeps, o: HashOriginal): boolean {
  if (o.verification_id) return true;
  const created = o.created_at ? Date.parse(o.created_at) : NaN;
  return Number.isFinite(created) && deps.now() - created < ORIGINAL_IN_PROGRESS_MS;
}

/**
 * Procura a original: hash exato primeiro, depois similaridade + mesmos fatos.
 * `via: "retry"`: mesmo hash, mas a original nunca concluiu a verificação.
 */
export async function findOriginal(
  deps: PipelineDeps,
  debateId: string,
  claim: ExtractedClaim,
  hash: string,
  embedding: number[] | null,
  settings: Pick<DebateSettings, "dedup_similarity">,
): Promise<{ original: Original; via: "hash" | "similarity" | "retry" } | null> {
  const byHash: HashOriginal | null = await deps.store.findClaimByHash(debateId, hash);
  if (byHash) return { original: byHash, via: settledOrInProgress(deps, byHash) ? "hash" : "retry" };
  if (!embedding) return null;
  // folga para afirmações de outros debates (que a RPC também devolve) não esconderem as deste
  const matches = await deps.store.matchVerifiedClaims(debateId, embedding, settings.dedup_similarity, 10);
  for (const m of matches) {
    if (m.similarity < settings.dedup_similarity) continue;
    // outro debate: nunca reaproveita veredito nem alerta (status, HITL e horário são de lá)
    if (m.debate_id !== debateId) continue;
    // nunca juntar "desemprego 6%" com "desemprego 8%", nem "subiu" com "caiu"
    if (!sameFacts(claim, { text_normalized: m.text_normalized, indicator: m.indicator })) continue;
    return {
      original: {
        claim_id: m.claim_id, verification_id: m.verification_id, verified_at: m.verified_at,
        alert_id: m.alert_id, alert_status: m.alert_status,
      },
      via: "similarity",
    };
  }
  return null;
}

export interface DedupArgs {
  debate_id: string;
  segment: Pick<Segment, "id" | "speaker_label" | "t_end">;
  claim: ExtractedClaim;
  hash: string;
  embedding: number[] | null;
  settings: DebateSettings;
}

function claimRow(a: DedupArgs, duplicateOf: string | null): NewClaim {
  return {
    debate_id: a.debate_id,
    segment_id: a.segment.id,
    speaker_label: a.segment.speaker_label,
    text_original: a.claim.text_original,
    text_normalized: a.claim.text_normalized,
    claim_hash: a.hash,
    numbers: a.claim.numbers,
    topic: a.claim.topic,
    indicator: a.claim.indicator,
    embedding: a.embedding,
    duplicate_of: duplicateOf,
  };
}

async function recordDuplicate(
  deps: PipelineDeps,
  a: DedupArgs,
  original: Original,
  via: "hash" | "similarity" | "race",
): Promise<DedupOutcome> {
  const { id } = await deps.store.insertClaim(claimRow(a, original.claim_id));
  let repeat: { id: string; status: AlertStatus } | null = null;
  if (original.alert_id && original.alert_status && original.alert_status !== "rejected") {
    const orig = await deps.store.getAlert(original.alert_id);
    if (orig) {
      repeat = await publishRepeat(deps.store, {
        debate_id: a.debate_id,
        claim_id: id,
        claim_text: a.claim.text_normalized,
        speaker_label: a.segment.speaker_label,
        segment_t_end: a.segment.t_end,
        original: orig,
        settings: a.settings,
      }, deps.logger);
    }
  }
  deps.logger("info", "claim_duplicate", {
    claim_id: id, original_claim_id: original.claim_id, via,
    verification_id: original.verification_id, repeat_alert_id: repeat?.id ?? null,
  });
  return {
    kind: "duplicate", claim_id: id, original_claim_id: original.claim_id, via,
    verification_id: original.verification_id, verified_at: original.verified_at, repeat_alert: repeat,
  };
}

/**
 * Aplica a trava e grava a claim. Devolve "new" (seguir para a verificação)
 * ou "duplicate" (verificação reaproveitada; alerta de repetição se a original teve alerta).
 */
export async function dedupAndRecord(deps: PipelineDeps, a: DedupArgs): Promise<DedupOutcome> {
  let found: Awaited<ReturnType<typeof findOriginal>> = null;
  try {
    found = await withTimeout(findOriginal(deps, a.debate_id, a.claim, a.hash, a.embedding, a.settings), TIMEOUTS_MS.dedup, "dedup");
  } catch (err) {
    // busca falhou: segue como nova — o índice único ainda barra repetição exata
    deps.logger("warn", "dedup_lookup_failed", errorFields(err));
  }
  if (found?.via === "retry") {
    // grava como duplicata (o índice único só admite uma original por hash) e verifica de novo
    const { id } = await deps.store.insertClaim(claimRow(a, found.original.claim_id));
    deps.logger("info", "claim_retry_unverified_original", { claim_id: id, original_claim_id: found.original.claim_id });
    return { kind: "new", claim_id: id, retry_of: found.original.claim_id };
  }
  if (found) return recordDuplicate(deps, a, found.original, found.via);

  try {
    const { id } = await deps.store.insertClaim(claimRow(a, null));
    return { kind: "new", claim_id: id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // corrida: outra invocação gravou o mesmo hash entre a busca e o insert
    const winner = await deps.store.findClaimByHash(a.debate_id, a.hash);
    if (!winner) throw err;
    return recordDuplicate(deps, a, winner, "race");
  }
}
