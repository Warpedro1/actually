import { describe, expect, it } from "vitest";
import {
  classifyError,
  computeMetrics,
  confusion,
  ERROR_REASON,
  falseAlarm,
  latencyByStage,
  listErrors,
  maxAlert,
  NO_CLAIM_REASON,
  percentile,
  precisionRecall,
  predictedAlert,
  silence,
  silenceReasons,
  sliceBy,
  TOTAL_KEY,
  yellowLenientPrecision,
} from "../src/metrics";
import { decision, rec, silent } from "./fixtures";

describe("percentile", () => {
  it("interpola linearmente", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 100)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 95)).toBeCloseTo(10.5);
  });
  it("vazio → null", () => expect(percentile([], 50)).toBeNull());
});

describe("predictedAlert", () => {
  it("pega o mais severo entre as afirmações", () => {
    expect(maxAlert([null, "yellow", "red"])).toBe("red");
    expect(maxAlert([null, "yellow"])).toBe("yellow");
    expect(maxAlert([])).toBeNull();
  });
  it("erro conta como silêncio", () => {
    expect(predictedAlert({ error: "boom", decisions: [decision()] })).toBeNull();
  });
});

const set = [
  rec("r1", "red", [decision()]), // VP vermelho
  rec("r2", "red", [silent("abaixo_threshold")]), // FN vermelho
  rec("r3", "red", [decision({ verdict: "impreciso", alert: "yellow" })]), // vermelho virou amarelo
  rec("y1", "yellow", [decision({ verdict: "impreciso", alert: "yellow" })]), // VP amarelo
  rec("y2", "yellow", [decision()]), // amarelo virou vermelho
  rec("t1", "true", [silent("confirmado", { verdict: "confirmado" })]),
  rec("t2", "true", [decision()], { speaker: "B" }), // falso alarme vermelho
  rec("n1", "none", [], { speaker: "B" }),
  rec("n2", "none", [decision({ verdict: "impreciso", alert: "yellow" })], { speaker: "B" }), // falso alarme amarelo
  rec("e1", "inconclusive", [], { error: "timeout", speaker: "B" }),
];

describe("[RNF02] precisionRecall", () => {
  it("vermelho", () => {
    const p = precisionRecall(set, "red");
    // emitidos: r1, y2, t2 → VP só r1
    expect(p).toMatchObject({ predicted: 3, expected: 3, tp: 1, fp: 2, fn: 2 });
    expect(p.precision).toBeCloseTo(1 / 3);
    expect(p.recall).toBeCloseTo(1 / 3);
  });
  it("amarelo estrito e tolerante", () => {
    const p = precisionRecall(set, "yellow");
    // emitidos: r3, y1, n2
    expect(p).toMatchObject({ predicted: 3, expected: 2, tp: 1, fp: 2, fn: 1 });
    expect(yellowLenientPrecision(set)).toBeCloseTo(2 / 3);
  });
  it("qualquer alerta", () => {
    const p = precisionRecall(set, "any");
    // emitidos: r1 r3 y1 y2 t2 n2 = 6; esperados: r1 r2 r3 y1 y2 = 5; VP = 4
    expect(p).toMatchObject({ predicted: 6, expected: 5, tp: 4, fp: 2, fn: 1 });
  });
  it("sem emissão → precisão null (não 0 nem 1)", () => {
    expect(precisionRecall([rec("x", "red", [])], "red").precision).toBeNull();
  });
});

describe("[RNF02] falseAlarm", () => {
  it("separa verdadeiras, não checáveis e união", () => {
    const f = falseAlarm(set);
    expect(f.on_true).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(f.on_uncheckable).toEqual({ n: 2, hits: 1, rate: 0.5 });
    expect(f.on_true_or_uncheckable).toEqual({ n: 4, hits: 2, rate: 0.5 });
    expect(f.on_no_alert_expected).toEqual({ n: 5, hits: 2, rate: 0.4 });
    expect(f.red_on_no_alert_expected.hits).toBe(1);
  });
});

describe("silêncio", () => {
  it("taxas", () => {
    const s = silence(set);
    expect(s.overall).toEqual({ n: 10, hits: 4, rate: 0.4 }); // r2 t1 n1 e1
    expect(s.on_expected_alert).toEqual({ n: 5, hits: 1, rate: 0.2 });
    expect(s.errors.hits).toBe(1);
  });
  it("distribuição de silence_reason inclui itens sem afirmação e com erro", () => {
    expect(silenceReasons(set)).toEqual({
      abaixo_threshold: 1,
      confirmado: 1,
      [NO_CLAIM_REASON]: 1,
      [ERROR_REASON]: 1,
    });
  });
});

describe("[RNF01] latencyByStage", () => {
  it("usa o máximo por item e exclui itens com erro", () => {
    const recs = [
      rec("a", "red", [decision({ latency_ms: { filter: 100, verify: 1000 } }), decision({ latency_ms: { filter: 100, verify: 3000 } })], { wall_ms: 3500 }),
      rec("b", "red", [decision({ latency_ms: { filter: 200, verify: 2000 } })], { wall_ms: 2500 }),
      rec("c", "red", [], { error: "x", wall_ms: 99999 }),
    ];
    const l = latencyByStage(recs);
    expect(l.verify).toMatchObject({ n: 2, p50: 2500, max: 3000 });
    expect(l.filter).toMatchObject({ n: 2, p50: 150 });
    expect(l[TOTAL_KEY]).toMatchObject({ n: 2, p50: 3000, max: 3500 });
  });
});

describe("[RNF04] confusão, recortes por speaker e erros", () => {
  it("matriz", () => {
    const m = confusion(set);
    expect(m.red).toEqual({ red: 1, yellow: 1, none: 1 });
    expect(m.yellow).toEqual({ red: 1, yellow: 1, none: 0 });
    expect(m.none).toEqual({ red: 1, yellow: 1, none: 3 });
  });
  it("recorte por speaker", () => {
    const s = sliceBy(set, (r) => r.speaker);
    expect(s.A!.n).toBe(6);
    expect(s.B!.n).toBe(4);
    expect(s.B!.false_alarm_rate).toBeCloseTo(2 / 4);
    expect(s.A!.false_alarm_rate).toBe(0);
  });
  it("classifica e ordena erros por gravidade", () => {
    expect(classifyError(null, "red")).toBe("vermelho indevido");
    expect(classifyError("red", null)).toBe("vermelho perdido");
    expect(classifyError("yellow", "red")).toBe("amarelo emitido como vermelho");
    expect(classifyError("red", "red")).toBeNull();
    const errs = listErrors(set);
    expect(errs.map((e) => e.item_id)).toEqual(["t2", "y2", "n2", "r2", "r3"]);
    expect(errs[0]!.decisions[0]!.evidence[0]!.url).toBe("https://ibge.gov.br/x");
  });
  it("computeMetrics agrega tudo", () => {
    const m = computeMetrics(set);
    expect(m.n_items).toBe(10);
    expect(m.n_decisions).toBe(8);
    expect(m.errors).toHaveLength(5);
    expect(Object.keys(m.by_topic)).toEqual(["(sem tópico)"]);
  });
});
