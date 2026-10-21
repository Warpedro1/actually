import type { ClaimDecision } from "@actually/pipeline";
import type { DecisionRecord, Expected } from "../src/dataset";

export function decision(over: Partial<ClaimDecision> = {}): ClaimDecision {
  return {
    claim: "afirmação",
    kind: "fato",
    review: false,
    verdict: "contradito",
    final_score: 0.9,
    alert: "red",
    silence_reason: null,
    layer: "L2",
    correction: "dado correto",
    evidence: [
      { url: "https://ibge.gov.br/x", source_name: "IBGE", source_tier: 1, quote: "trecho", quote_verified: true },
    ],
    latency_ms: { filter: 100, verify: 1000 },
    ...over,
  };
}

const EXP: Record<string, Expected> = {
  red: { checkable: true, verdict: "contradito", alert: "red" },
  yellow: { checkable: true, verdict: "impreciso", alert: "yellow" },
  true: { checkable: true, verdict: "confirmado", alert: null },
  none: { checkable: false, verdict: null, alert: null },
  inconclusive: { checkable: true, verdict: "inconclusivo", alert: null },
};

export function rec(
  id: string,
  exp: keyof typeof EXP,
  decisions: ClaimDecision[],
  over: Partial<DecisionRecord> = {},
): DecisionRecord {
  return {
    item_id: id,
    source: "sintetico",
    speaker: "A",
    topic: null,
    text: `texto ${id}`,
    expected: EXP[exp]!,
    synthetic: true,
    reference_urls: [],
    wall_ms: 1000,
    error: null,
    decisions,
    ...over,
  };
}

export const silent = (reason: string, over: Partial<ClaimDecision> = {}) =>
  decision({ alert: null, silence_reason: reason, ...over });
