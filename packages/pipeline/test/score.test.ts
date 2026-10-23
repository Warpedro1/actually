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
  it("vermelho de fato/estatística aceita tier 3 (a regra não barra mais), mas o peso do nível 3 ainda cobra concordância", () => {
    // tier 3 pesa 0,6: uma camada só dá 0,5·0,95 + 0,2·0,6 + 0,2·0,5 + 0,1 = 0,795 < t_red 0,85.
    // Não é mais a regra de nível que cala, é o limiar — o motivo no log diz isso.
    const um = scoreDecision(base({ evidence: [ev({ source_tier: 3 })] }));
    expect(um).toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold" });
    expect(um.final_score).toBeCloseTo(0.795, 4);
    // duas camadas de nível 3 que concordam: 0,895 ⇒ vermelho publicável
    const duas = scoreDecision(base({
      evidence: [ev({ source_tier: 3 }), ev({ source_tier: 3, layer: "L1", factcheck_verdict: "contradito" })],
      citations_total: 2,
      citations_verified: 2,
    }));
    expect(duas).toMatchObject({ alert: "red", silence_reason: null });
    // tier 4 segue barrado pela regra de nível, com qualquer score
    expect(scoreDecision(base({ evidence: [ev({ source_tier: 4 })] })).silence_reason).toBe("fonte_tier_4");
  });
  it("vermelho ainda exige citação verificada, em qualquer nível", () => {
    const r = scoreDecision(base({ evidence: [ev({ source_tier: 3, quote_verified: false })], citations_verified: 0 }));
    expect(r.silence_reason).toBe("sem_citacao_verificada");
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
    // 0,79 < 0,85 e fora da faixa de revisão (0,80–0,85, ver fidelity.test.ts)
    expect(scoreDecision(base({ model_confidence: 0.78 })).silence_reason).toBe("abaixo_do_threshold");
    expect(scoreDecision(base({ model_confidence: 0.78, settings: { ...DEFAULT_SETTINGS, t_red: 0.75 } })).alert).toBe("red");
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

describe("[RF02] [RF04] regras por tipo de fala", () => {
  it("fato e estatística: vermelho até o nível 3, sem revisão forçada", () => {
    expect(scoreDecision(base({ kind: "fato" }))).toMatchObject({ alert: "red", review: false });
    expect(scoreDecision(base({ kind: "estatistica" }))).toMatchObject({ alert: "red", review: false });
  });

  it("opinião mensurável nunca é vermelha: contradito vira amarelo, com limite maior", () => {
    const r = scoreDecision(base({ kind: "opiniao_mensuravel" }));
    expect(r).toMatchObject({ alert: "yellow", review: false });
    expect(r.components).toMatchObject({
      kind: "opiniao_mensuravel", level_capped: true, threshold: DEFAULT_SETTINGS.t_yellow + 0.1,
    });
  });

  it("opinião mensurável: score que passaria num fato fica em silêncio (limite +0,1)", () => {
    // 0,5·0,7 + 0,2·1 + 0,2·0,5 + 0,1·1 = 0,75 ⇒ fato amarelo (0,75); opinião exige 0,85
    const input = { verdict: "impreciso" as const, model_confidence: 0.7 };
    expect(scoreDecision(base({ ...input, kind: "fato" }))).toMatchObject({ alert: "yellow" });
    expect(scoreDecision(base({ ...input, kind: "opiniao_mensuravel" }))).toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold" });
  });

  it("opinião mensurável só com fonte de nível 1–2, mesmo em amarelo", () => {
    const tier3 = [ev({ source_tier: 3 })];
    expect(scoreDecision(base({ verdict: "impreciso", evidence: tier3, kind: "fato" }))).toMatchObject({ alert: "yellow" });
    expect(scoreDecision(base({ verdict: "impreciso", evidence: tier3, kind: "opiniao_mensuravel" })))
      .toMatchObject({ alert: null, silence_reason: "tipo_exige_tier_2" });
  });

  it("acusação aceita nível 1, 2 e 3, e sempre passa pelo editor — nível 4 nunca", () => {
    expect(scoreDecision(base({ kind: "acusacao" }))).toMatchObject({ alert: "red", review: true });
    // nível 2: o peso (0,85) ainda chega ao limiar do vermelho com confiança alta
    expect(scoreDecision(base({ kind: "acusacao", evidence: [ev({ source_tier: 2 })], model_confidence: 1 })))
      .toMatchObject({ alert: "red", review: true });
    expect(scoreDecision(base({ kind: "acusacao", verdict: "impreciso", evidence: [ev({ source_tier: 3 })] })))
      .toMatchObject({ alert: "yellow", review: true });
    // a regra de nível não barra mais o vermelho de acusação em nível 3; quem decide é o limiar
    expect(scoreDecision(base({ kind: "acusacao", evidence: [ev({ source_tier: 3 })] })))
      .toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold", review: false });
    expect(scoreDecision(base({ kind: "acusacao", evidence: [ev({ source_tier: 4 })] })))
      .toMatchObject({ alert: null, silence_reason: "fonte_tier_4" });
  });

  it("silêncio nunca pede revisão", () => {
    expect(scoreDecision(base({ kind: "acusacao", verdict: "confirmado" }))).toMatchObject({ alert: null, review: false });
  });
});

describe("[RF07] base fraca + web: a evidência fraca não infla o score", () => {
  const web = ev({ layer: "L4", evidence_type: "web", source_tier: 2, url: "https://g1.globo.com/x" });
  const weakDoc = ev({ layer: "L3", source_tier: 1, weak: true });
  it("documento fraco + web não conta como 2 camadas nem tira o acréscimo da web", () => {
    const input = { model_confidence: 0.8, citations_total: 2, citations_verified: 2 };
    const onlyWeb = scoreDecision(base({ ...input, evidence: [web], citations_total: 1, citations_verified: 1 }));
    const both = scoreDecision(base({ ...input, evidence: [weakDoc, web] }));
    expect(onlyWeb.alert).toBeNull();
    expect(both.alert).toBeNull();
    expect(both.components).toMatchObject({ agreement: 0.5, used_web: true, best_layer: "L4" });
  });
  it("documento forte + web continua contando como 2 camadas", () => {
    const strongDoc = ev({ layer: "L3", source_tier: 1 });
    const r = scoreDecision(base({ model_confidence: 0.8, evidence: [strongDoc, web], citations_total: 2, citations_verified: 2 }));
    expect(r.components).toMatchObject({ agreement: 1, used_web: false });
  });
  it("checagem fraca que discorda ainda silencia (conflito olha tudo)", () => {
    const weakFc = ev({ layer: "L1", source_tier: 1, weak: true, factcheck_verdict: "confirmado" });
    expect(scoreDecision(base({ evidence: [weakFc, web], citations_total: 2, citations_verified: 2 })))
      .toMatchObject({ alert: null, silence_reason: "camadas_em_conflito" });
  });
});

describe("[RF07] [RF04] checagem de agência achada pela web não paga o acréscimo da web", () => {
  // casos do ensaio de 18/10 (Band): a checagem da agência sobre a mesma fala veio com a web
  const uolConfere = ev({
    layer: "L4", evidence_type: "web", source_name: "UOL Confere", source_tier: 1,
    url: "https://noticias.uol.com.br/confere/ultimas-noticias/2022/09/12/lula-e-inocente-foi-absolvido-pela-onu-e-pelo-stf-entenda.htm",
  });
  const g1 = ev({ layer: "L4", evidence_type: "web", source_name: "g1", source_tier: 2, url: "https://g1.globo.com/politica/noticia/2025/09/04/x.ghtml" });
  const estadao = ev({ layer: "L4", evidence_type: "web", source_name: "Estadão", source_tier: 2, url: "https://www.estadao.com.br/politica/vorcaro-diz-em-audio" });
  const withPenalty = DEFAULT_SETTINGS.t_yellow + DEFAULT_SETTINGS.web_penalty;

  it("agência nível 1 da web: o limiar é o da base, sem web_penalty", () => {
    // 0,5·0,72 + 0,2·1 + 0,2·0,5 + 0,1·1 = 0,76: passa em 0,75, não em 0,80
    const r = scoreDecision(base({ verdict: "impreciso", model_confidence: 0.72, evidence: [uolConfere] }));
    expect(r).toMatchObject({ alert: "yellow", silence_reason: null });
    expect(r.components).toMatchObject({ used_web: true, web_penalty_waived: true, best_layer: "L4" });
    expect(r.components.threshold).toBeCloseTo(DEFAULT_SETTINGS.t_yellow);
  });

  it("a mesma checagem que entrou fraca junto com a web também não paga (t≈1491, R$ 30 milhões)", () => {
    // acusação: UOL Confere na L3 fraca + Estadão na web ⇒ 0,77; com o acréscimo, o limiar era 0,80
    const weakAgency = ev({
      layer: "L3", source_name: "UOL Confere", source_tier: 1, weak: true,
      url: "https://noticias.uol.com.br/confere/ultimas-noticias/2026/10/19/debate-band-checagem-flavio-lula.ghtm",
    });
    const input = { verdict: "impreciso" as const, kind: "acusacao" as const, model_confidence: 0.8, citations_total: 2, citations_verified: 2 };
    const r = scoreDecision(base({ ...input, evidence: [weakAgency, estadao] }));
    expect(r.final_score).toBeCloseTo(0.77, 4);
    // acusação continua passando pelo editor; a melhor fonte (forte) segue sendo a da web
    expect(r).toMatchObject({ alert: "yellow", review: true });
    expect(r.components).toMatchObject({ web_penalty_waived: true, best_layer: "L4", best_tier: 2 });
    expect(r.components.threshold).toBeCloseTo(DEFAULT_SETTINGS.t_yellow);
    // sem a checagem da agência, o acréscimo volta
    const alone = scoreDecision(base({ ...input, evidence: [estadao], citations_total: 1, citations_verified: 1 }));
    expect(alone).toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold" });
    expect(alone.components.threshold).toBeCloseTo(withPenalty);
  });

  it("não vale para fonte oficial ou imprensa da web, nível gravado diferente de 1 nem citação não conferida", () => {
    const c = { verdict: "impreciso" as const, model_confidence: 0.72 };
    const cases = [
      ev({ layer: "L4", evidence_type: "web", url: "https://www.ibge.gov.br/explica/desemprego.php" }),
      ev({ layer: "L4", evidence_type: "web", source_tier: 2, url: "https://g1.globo.com/economia/noticia/x.ghtml" }),
      // endereço de agência com nível gravado diferente de 1: na dúvida, o acréscimo fica
      { ...uolConfere, source_tier: 2 as const },
      // fora do caminho da agência é o UOL (nível 3), mesmo que a evidência diga nível 1
      ev({ layer: "L4", evidence_type: "web", source_tier: 1, url: "https://noticias.uol.com.br/politica/x.htm" }),
    ];
    for (const e of cases) {
      const r = scoreDecision(base({ ...c, evidence: [e] }));
      expect(r.components.web_penalty_waived, e.url).toBeUndefined();
      expect(r.components.threshold, e.url).toBeCloseTo(withPenalty);
    }
    const unverified = scoreDecision(base({
      ...c, evidence: [{ ...uolConfere, quote_verified: false }, g1], citations_total: 2, citations_verified: 1,
    }));
    expect(unverified.components.web_penalty_waived).toBeUndefined();
    expect(unverified.components.threshold).toBeCloseTo(withPenalty);
  });

  it("regras duras não mudam: vermelho de acusação abaixo do limiar continua em silêncio (t≈2128, condenado pelo STF)", () => {
    // 0,5·0,82 + 0,2·1 + 0,2·0,5 + 0,1·1 = 0,81: o limiar cai de 0,90 para 0,85, e 0,81 ainda não passa
    const r = scoreDecision(base({
      kind: "acusacao", model_confidence: 0.82, evidence: [uolConfere, g1], citations_total: 2, citations_verified: 2,
    }));
    expect(r.final_score).toBeCloseTo(0.81, 4);
    expect(r).toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold", review: false });
    expect(r.components).toMatchObject({ web_penalty_waived: true });
    expect(r.components.threshold).toBeCloseTo(DEFAULT_SETTINGS.t_red);
  });

  it("vermelho de fato logo abaixo do limiar vai ao editor (faixa de revisão), nunca direto ao público", () => {
    // 0,80: sem o acréscimo, fica na faixa 0,80–0,85 do vermelho
    const r = scoreDecision(base({ model_confidence: 0.8, evidence: [uolConfere] }));
    expect(r).toMatchObject({ alert: "red", review: true, components: { review_band: true, web_penalty_waived: true } });
  });

  it("nível 4 continua sem sustentar alerta (conteúdo patrocinado da web)", () => {
    const sponsored = ev({ layer: "L4", evidence_type: "web", source_tier: 4, url: "https://bluestudio.estadao.com.br/x" });
    const r = scoreDecision(base({ verdict: "impreciso", model_confidence: 1, evidence: [sponsored] }));
    expect(r).toMatchObject({ alert: null, silence_reason: "fonte_tier_4" });
  });
});
