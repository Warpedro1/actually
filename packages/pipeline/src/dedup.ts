// TRAVA DE REPETIÇÃO: afirmação já verificada não é reprocessada.
// (1) mesmo claim_hash no debate; (2) match_verified_claims com similaridade
// ≥ dedup_similarity E mesmos números/período/polaridade. Corrida entre
// invocações paralelas: o índice único claims_unique_hash (23505) decide.
import type { AlertStatus, DebateSettings, Segment } from "@actually/db";
import { TIMEOUTS_MS } from "./config";
import type { PipelineDeps } from "./deps";
import { errorFields, withTimeout } from "./log";
import { sameFacts } from "./normalize";
import { publishRepeat } from "./publish";
import { isUniqueViolation, type HashMatch, type NewClaim } from "./store";
import type { ExtractedClaim } from "./types";

export type DedupOutcome =
  | { kind: "new"; claim_id: string }
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

/** Procura a original: hash exato primeiro, depois similaridade + mesmos fatos. */
export async function findOriginal(
  deps: PipelineDeps,
  debateId: string,
  claim: ExtractedClaim,
  hash: string,
  embedding: number[] | null,
  settings: Pick<DebateSettings, "dedup_similarity">,
): Promise<{ original: Original; via: "hash" | "similarity" } | null> {
  const byHash: HashMatch | null = await deps.store.findClaimByHash(debateId, hash);
  if (byHash) return { original: byHash, via: "hash" };
  if (!embedding) return null;
  const matches = await deps.store.matchVerifiedClaims(debateId, embedding, settings.dedup_similarity, 5);
  for (const m of matches) {
    if (m.similarity < settings.dedup_similarity) continue;
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
