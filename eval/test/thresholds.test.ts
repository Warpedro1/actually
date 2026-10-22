import { describe, expect, it } from "vitest";
import { agreement, decideAlert, grid, recommend, rethreshold, sweepRed, sweepYellow, type SweepPoint } from "../src/thresholds";
import { decision, rec } from "./fixtures";

const T = { t_red: 0.85, t_yellow: 0.75, web_penalty: 0.05 };

describe("decideAlert", () => {
  it("aplica threshold por nível", () => {
    expect(decideAlert(decision({ final_score: 0.86 }), T)).toBe("red");
    expect(decideAlert(decision({ final_score: 0.84 }), T)).toBeNull();
    expect(decideAlert(decision({ verdict: "impreciso", final_score: 0.76 }), T)).toBe("yellow");
    expect(decideAlert(decision({ verdict: "impreciso", final_score: 0.74 }), T)).toBeNull();
  });
  it("web soma penalidade ao threshold", () => {
    expect(decideAlert(decision({ final_score: 0.88, layer: "L4" }), T)).toBeNull();
    expect(decideAlert(decision({ final_score: 0.9, layer: "L4" }), T)).toBe("red");
  });
  it("[RF07] checagem de agência (nível 1) com citação verificada não paga a penalidade da web (espelho de score.ts)", () => {
    const agency = { url: "https://noticias.uol.com.br/confere/ultimas-noticias/2022/09/12/x.htm", source_name: "UOL Confere", source_tier: 1 as const, quote: "trecho", quote_verified: true };
    expect(decideAlert(decision({ final_score: 0.86, layer: "L4", evidence: [agency] }), T)).toBe("red");
    expect(decideAlert(decision({ verdict: "impreciso", final_score: 0.76, layer: "L4", evidence: [agency] }), T)).toBe("yellow");
    // citação da agência não conferida: a penalidade volta
    const unverified = [{ ...agency, quote_verified: false }, { url: "https://g1.globo.com/x", source_name: "g1", source_tier: 2 as const, quote: "x", quote_verified: true }];
    expect(decideAlert(decision({ final_score: 0.86, layer: "L4", evidence: unverified }), T)).toBeNull();
  });
  it("confirmado/inconclusivo nunca alertam", () => {
    expect(decideAlert(decision({ verdict: "confirmado", final_score: 1 }), T)).toBeNull();
    expect(decideAlert(decision({ verdict: "inconclusivo", final_score: 1 }), T)).toBeNull();
  });
  it("regras duras independem do threshold", () => {
    const zero = { t_red: 0, t_yellow: 0, web_penalty: 0 };
    const unverified = decision({ final_score: 1, evidence: [{ url: "https://ibge.gov.br", source_name: "IBGE", source_tier: 1, quote: "x", quote_verified: false }] });
    expect(decideAlert(unverified, zero)).toBeNull();
    const tier3 = decision({ final_score: 1, evidence: [{ url: "https://uol.com.br/x", source_name: "UOL", source_tier: 3, quote: "x", quote_verified: true }] });
    expect(decideAlert(tier3, zero)).toBeNull();
    // amarelo aceita tier 3 com citação verificada
    expect(decideAlert({ ...tier3, verdict: "impreciso" }, zero)).toBe("yellow");
    expect(decideAlert(decision({ evidence: [] }), zero)).toBeNull();
  });
});

describe("[RNF02] [RF07] varredura de thresholds", () => {
  // 3 vermelhos esperados com scores altos, 1 falso alarme com score 0.8
  const recs = [
    rec("r1", "red", [decision({ final_score: 0.95 })]),
    rec("r2", "red", [decision({ final_score: 0.9 })]),
    rec("r3", "red", [decision({ final_score: 0.7 })]),
    rec("t1", "true", [decision({ final_score: 0.8 })]),
    rec("y1", "yellow", [decision({ verdict: "impreciso", final_score: 0.78 })]),
    rec("n1", "none", [decision({ verdict: "impreciso", final_score: 0.7 })]),
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
