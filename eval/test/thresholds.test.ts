import { describe, expect, it } from "vitest";
import { agreement, decideAlert, grid, recommend, rethreshold, sweepRed, sweepYellow, type SweepPoint } from "../src/thresholds";
import { decision, rec, silent } from "./fixtures";

const T = { t_red: 0.85, t_yellow: 0.75, web_penalty: 0.05 };

describe("decideAlert", () => {
  // Os casos abaixo ficam fora da faixa de revisão (que tem teste próprio): ou
  // acima do limiar, ou mais de RED_REVIEW_BAND abaixo dele.
  it("aplica threshold por nível", () => {
    expect(decideAlert(decision({ final_score: 0.86 }), T)).toBe("red");
    expect(decideAlert(decision({ final_score: 0.78 }), T)).toBeNull();
    expect(decideAlert(decision({ verdict: "impreciso", final_score: 0.76 }), T)).toBe("yellow");
    expect(decideAlert(decision({ verdict: "impreciso", final_score: 0.74 }), T)).toBeNull();
  });
  it("web soma penalidade ao threshold", () => {
    expect(decideAlert(decision({ final_score: 0.82, layer: "L4" }), T)).toBeNull();
    expect(decideAlert(decision({ final_score: 0.9, layer: "L4" }), T)).toBe("red");
  });
  it("[RF07] checagem de agência (nível 1) com citação verificada não paga a penalidade da web (espelho de score.ts)", () => {
    const agency = { url: "https://noticias.uol.com.br/confere/ultimas-noticias/2022/09/12/x.htm", source_name: "UOL Confere", source_tier: 1 as const, quote: "trecho", quote_verified: true };
    expect(decideAlert(decision({ final_score: 0.86, layer: "L4", evidence: [agency] }), T)).toBe("red");
    expect(decideAlert(decision({ verdict: "impreciso", final_score: 0.76, layer: "L4", evidence: [agency] }), T)).toBe("yellow");
    // citação da agência não conferida: a penalidade volta
    const unverified = [{ ...agency, quote_verified: false }, { url: "https://g1.globo.com/x", source_name: "g1", source_tier: 2 as const, quote: "x", quote_verified: true }];
    expect(decideAlert(decision({ final_score: 0.82, layer: "L4", evidence: unverified }), T)).toBeNull();
  });
  it("[RF07] nível da fonte segue a regra do tipo da fala (KIND_RULES), não um limite fixo", () => {
    const zero = { t_red: 0, t_yellow: 0, web_penalty: 0 };
    const tier3 = [{ url: "https://uol.com.br/x", source_name: "UOL", source_tier: 3 as const, quote: "x", quote_verified: true }];
    // fato, estatística e acusação: vermelho aceita nível 3 (red_max_tier 3)
    for (const kind of ["fato", "estatistica", "acusacao"] as const) {
      expect(decideAlert(decision({ kind, final_score: 1, evidence: tier3 }), zero)).toBe("red");
    }
    // opinião mensurável: nunca vermelho (no máximo impreciso) e exige nível ≤ 2
    const op = decision({ kind: "opiniao_mensuravel", final_score: 1, evidence: tier3 });
    expect(decideAlert(op, zero)).toBeNull();
    const tier2 = [{ url: "https://g1.globo.com/x", source_name: "g1", source_tier: 2 as const, quote: "x", quote_verified: true }];
    expect(decideAlert({ ...op, evidence: tier2 }, zero)).toBe("yellow");
    // e paga o acréscimo do tipo (extra_threshold 0,1): 0,80 não passa de t_yellow 0,75
    expect(decideAlert({ ...op, evidence: tier2, verdict: "impreciso", final_score: 0.8 }, T)).toBeNull();
    expect(decideAlert({ ...op, evidence: tier2, verdict: "impreciso", final_score: 0.86 }, T)).toBe("yellow");
  });

  it("[RF07] faixa de revisão: vermelho de fato logo abaixo do limiar conta como emitido", () => {
    // 0,83 está dentro de 0,05 abaixo de t_red, com confiança do modelo alta
    expect(decideAlert(decision({ final_score: 0.83, model_confidence: 0.9 }), T)).toBe("red");
    // confiança baixa não entra na faixa
    expect(decideAlert(decision({ final_score: 0.83, model_confidence: 0.5 }), T)).toBeNull();
    // acusação não tem faixa de revisão
    expect(decideAlert(decision({ kind: "acusacao", final_score: 0.83, model_confidence: 0.9 }), T)).toBeNull();
    // e abaixo da faixa, silêncio
    expect(decideAlert(decision({ final_score: 0.79, model_confidence: 0.9 }), T)).toBeNull();
  });

  it("[RF07] silêncio que não depende de limiar continua silêncio com qualquer limiar", () => {
    const zero = { t_red: 0, t_yellow: 0, web_penalty: 0 };
    for (const reason of ["camadas_em_conflito", "numero_sem_fonte", "sem_correcao", "l2_divergente"]) {
      expect(decideAlert(silent(reason, { final_score: 1 }), zero)).toBeNull();
    }
    // "abaixo_do_threshold" é o único recalculável: com limiar menor, sai
    expect(decideAlert(silent("abaixo_do_threshold", { final_score: 0.6 }), zero)).toBe("red");
  });

  it("confirmado/inconclusivo nunca alertam", () => {
    expect(decideAlert(decision({ verdict: "confirmado", final_score: 1 }), T)).toBeNull();
    expect(decideAlert(decision({ verdict: "inconclusivo", final_score: 1 }), T)).toBeNull();
  });
  it("regras duras independem do threshold", () => {
    const zero = { t_red: 0, t_yellow: 0, web_penalty: 0 };
    const unverified = decision({ final_score: 1, evidence: [{ url: "https://ibge.gov.br", source_name: "IBGE", source_tier: 1, quote: "x", quote_verified: false }] });
    expect(decideAlert(unverified, zero)).toBeNull();
    // nível 4 nunca sustenta alerta, em nenhum tipo
    const tier4 = decision({ final_score: 1, evidence: [{ url: "https://blog.exemplo.com/x", source_name: "Blog", source_tier: 4, quote: "x", quote_verified: true }] });
    expect(decideAlert(tier4, zero)).toBeNull();
    expect(decideAlert({ ...tier4, verdict: "impreciso" }, zero)).toBeNull();
    expect(decideAlert(decision({ evidence: [] }), zero)).toBeNull();
  });
});

describe("[RNF02] [RF07] varredura de thresholds", () => {
  // 3 vermelhos esperados com scores altos, 1 falso alarme com score 0.8.
  // Confiança do modelo abaixo de RED_REVIEW_MIN_CONFIDENCE: a faixa de revisão
  // tem teste próprio e aqui só se mede a curva do limiar.
  const low = { model_confidence: 0.6 };
  const recs = [
    rec("r1", "red", [decision({ ...low, final_score: 0.95 })]),
    rec("r2", "red", [decision({ ...low, final_score: 0.9 })]),
    rec("r3", "red", [decision({ ...low, final_score: 0.7 })]),
    rec("t1", "true", [decision({ ...low, final_score: 0.8 })]),
    rec("y1", "yellow", [decision({ ...low, verdict: "impreciso", final_score: 0.78 })]),
    rec("n1", "none", [decision({ ...low, verdict: "impreciso", final_score: 0.7 })]),
  ];

  it("grid inclui as pontas sem erro de ponto flutuante", () => {
    expect(grid(0.5, 0.6, 0.05)).toEqual([0.5, 0.55, 0.6]);
  });

  it("curva de vermelho e recomendação do menor threshold estável", () => {
    const pts = sweepRed(recs, T, grid(0.6, 0.95, 0.05));
    const at = (t: number) => pts.find((p) => p.t_red === t)!;
    expect(at(0.65)).toMatchObject({ emitted: 4 });
    expect(at(0.65).precision).toBeCloseTo(0.75);
    expect(at(0.85)).toMatchObject({ emitted: 2, precision: 1 });
    expect(at(0.85).recall).toBeCloseTo(2 / 3);
    const r = recommend(pts, "t_red", 0.9);
    expect(r?.t_red).toBe(0.85);
  });

  it("recomendação ignora vale de sorte abaixo de uma queda", () => {
    const pts: SweepPoint[] = [
      { ...T, t_red: 0.6, emitted: 5, precision: 0.95, recall: 1 },
      { ...T, t_red: 0.7, emitted: 4, precision: 0.8, recall: 0.9 },
      { ...T, t_red: 0.8, emitted: 3, precision: 0.92, recall: 0.8 },
      { ...T, t_red: 0.9, emitted: 0, precision: null, recall: 0 },
    ];
    expect(recommend(pts, "t_red", 0.9)?.t_red).toBe(0.8);
    expect(recommend(pts, "t_red", 0.99)).toBeNull();
  });

  it("amarelo: precisão tolerante", () => {
    const pts = sweepYellow(recs, T, [0.65, 0.75]);
    expect(pts[0]).toMatchObject({ emitted: 2, precision: 0.5, lenient_precision: 0.5 });
    expect(pts[1]).toMatchObject({ emitted: 1, precision: 1, lenient_precision: 1 });
  });

  it("concordância com as decisões salvas", () => {
    const saved = rethreshold(recs, T);
    expect(agreement(saved, T)).toEqual({ n: 6, agree: 6, rate: 1 });
    expect(agreement(saved, { ...T, t_red: 0.5 }).agree).toBeLessThan(6);
  });
});
