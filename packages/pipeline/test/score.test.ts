import { DEFAULT_SETTINGS } from "@actually/db";
import { describe, expect, it } from "vitest";
import { layerAgreement, scoreDecision, type ScoreInput } from "../src/score";
import type { EvidenceRecord, IndicatorComparison } from "../src/types";

const ev = (over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  layer: "L3", evidence_type: "document", url: "https://www.ibge.gov.br/x", source_name: "IBGE",
  source_tier: 1, quote: "trecho", quote_verified: true, published_at: null, quote_similarity: 1, ...over,
});

const cmp = (expected: IndicatorComparison["expected_verdict"]): IndicatorComparison => ({
  status: expected === "contradito" ? "mismatch" : expected === "impreciso" ? "minor_mismatch" : "match",
  expected_verdict: expected, series_code: "s", claimed: 1, actual: 2, tolerance: 0.3, evidence_text: "Série", reason: "",
});

const base = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  verdict: "contradito",
  model_confidence: 0.95,
  evidence: [ev()],
  citations_total: 1,
  citations_verified: 1,
  comparison: null,
  forced_reason: null,
  correction: "Segundo o IBGE, foi 7,8%.",
  correction_numbers_ok: true,
  settings: DEFAULT_SETTINGS,
  ...over,
});

describe("[RF07] scoreDecision — fórmula", () => {
  it("0,5·conf + 0,2·tier + 0,2·concordância + 0,1·citações", () => {
    // uma camada só ⇒ concordância 0,5
    const r = scoreDecision(base());
    expect(r.final_score).toBeCloseTo(0.5 * 0.95 + 0.2 * 1 + 0.2 * 0.5 + 0.1 * 1, 4);
    expect(r.components).toMatchObject({ tier: 1, agreement: 0.5, quote_fraction: 1 });
  });
  it("vermelho com fonte tier 1 e confiança alta", () => {
    expect(scoreDecision(base())).toMatchObject({ alert: "red", silence_reason: null, layer: "L3" });
  });
  it("amarelo para impreciso", () => {
    expect(scoreDecision(base({ verdict: "impreciso", model_confidence: 0.8 }))).toMatchObject({ alert: "yellow" });
  });
  it("tier 2 pesa 0,85; L2 concordante dá concordância 1", () => {
    const r = scoreDecision(base({ evidence: [ev({ source_tier: 2 })] }));
    expect(r.components.tier).toBe(0.85);
    const r2 = scoreDecision(base({ evidence: [ev({ layer: "L2", evidence_type: "indicator" })], comparison: cmp("contradito") }));
    expect(r2.components.agreement).toBe(1);
  });
  it("duas camadas com citação verificada ⇒ concordância 1", () => {
    expect(scoreDecision(base({ evidence: [ev(), ev({ layer: "L1", factcheck_verdict: "contradito" })], citations_total: 2, citations_verified: 2 })).components.agreement).toBe(1);
  });
});

describe("[RF07] [RF05] scoreDecision — regras duras", () => {
  it("confirmado e inconclusivo nunca geram alerta", () => {
    expect(scoreDecision(base({ verdict: "confirmado" }))).toMatchObject({ alert: null, silence_reason: "confirmado" });
    expect(scoreDecision(base({ verdict: "inconclusivo" }))).toMatchObject({ alert: null, silence_reason: "inconclusivo" });
  });
  it("inconclusivo forçado (refusal/parse/timeout) ⇒ silêncio com o motivo", () => {
    expect(scoreDecision(base({ forced_reason: "refusal" }))).toMatchObject({ alert: null, silence_reason: "refusal" });
  });
  it("qualquer alerta exige ≥ 1 evidência com quote_verified", () => {
    const r = scoreDecision(base({ evidence: [ev({ quote_verified: false })], citations_verified: 0 }));
    expect(r).toMatchObject({ alert: null, silence_reason: "sem_citacao_verificada" });
    expect(scoreDecision(base({ verdict: "impreciso", evidence: [] })).silence_reason).toBe("sem_citacao_verificada");
  });
  it("vermelho exige evidência tier ≤ 2 verificada (tier 3 não basta; não rebaixa para amarelo)", () => {
    const r = scoreDecision(base({ evidence: [ev({ source_tier: 3 })] }));
    expect(r).toMatchObject({ alert: null, silence_reason: "vermelho_exige_tier_1_2" });
    // a fonte tier 1 existe mas a citação dela não foi verificada
    const r2 = scoreDecision(base({ evidence: [ev({ source_tier: 1, quote_verified: false }), ev({ source_tier: 3 })] }));
    expect(r2.silence_reason).toBe("vermelho_exige_tier_1_2");
  });
  it("amarelo aceita tier 3, mas tier 4 nunca sustenta alerta", () => {
    expect(scoreDecision(base({ verdict: "impreciso", evidence: [ev({ source_tier: 3 })], model_confidence: 1 })).alert).toBe("yellow");
    expect(scoreDecision(base({ verdict: "impreciso", evidence: [ev({ source_tier: 4 })], model_confidence: 1 })).silence_reason).toBe("fonte_tier_4");
  });
  it("web (L4) soma web_penalty ao threshold", () => {
    // score = 0,5·c + 0,4 (tier 1, concordância 0,5, citações 1); t_yellow 0,75
    const c = 0.72; // score 0,76: passa em 0,75, não passa em 0,80
    expect(scoreDecision(base({ verdict: "impreciso", model_confidence: c })).alert).toBe("yellow");
    const web = scoreDecision(base({ verdict: "impreciso", model_confidence: c, evidence: [ev({ layer: "L4", evidence_type: "web" })] }));
    expect(web).toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold" });
    expect(web.components.threshold).toBeCloseTo(0.8);
  });
  it("abaixo do threshold ⇒ silêncio (thresholds das settings)", () => {
    expect(scoreDecision(base({ model_confidence: 0.8 })).silence_reason).toBe("abaixo_do_threshold"); // 0,8 < 0,85
    expect(scoreDecision(base({ model_confidence: 0.8, settings: { ...DEFAULT_SETTINGS, t_red: 0.75 } })).alert).toBe("red");
  });
  it("L2 divergente do modelo ⇒ silêncio", () => {
    const r = scoreDecision(base({ comparison: cmp("confirmado"), evidence: [ev({ layer: "L2" })] }));
    expect(r).toMatchObject({ alert: null, silence_reason: "l2_divergente" });
    // até divergência parcial (comparador: impreciso; modelo: contradito)
    expect(scoreDecision(base({ comparison: cmp("impreciso") })).silence_reason).toBe("l2_divergente");
  });
  it("camadas em conflito (checagem diz confirmado, modelo acusa) ⇒ silêncio", () => {
    const r = scoreDecision(base({ evidence: [ev(), ev({ layer: "L1", factcheck_verdict: "confirmado" })] }));
    expect(r).toMatchObject({ alert: null, silence_reason: "camadas_em_conflito" });
  });
  it("sem correção ou com número sem fonte ⇒ silêncio", () => {
    expect(scoreDecision(base({ correction: " " })).silence_reason).toBe("sem_correcao");
    expect(scoreDecision(base({ correction_numbers_ok: false })).silence_reason).toBe("numero_sem_fonte");
  });
  it("score sempre em [0,1]", () => {
    const r = scoreDecision(base({ model_confidence: 7 }));
    expect(r.final_score).toBeLessThanOrEqual(1);
    expect(scoreDecision(base({ model_confidence: -1, evidence: [] })).final_score).toBeGreaterThanOrEqual(0);
  });
});

describe("layerAgreement", () => {
  it("parcial (contradito x impreciso) ⇒ 0,25", () => {
    const a = layerAgreement("contradito", [ev(), ev({ layer: "L1", factcheck_verdict: "impreciso" })], null);
    expect(a).toEqual({ agreement: 0.25, conflict: false, l2_divergent: false });
  });
});
