import type { IndicatorRef, IndicatorSeries, IndicatorValue } from "@actually/db";
import { describe, expect, it } from "vitest";
import {
  classify, compareIndicator, parsePeriod, toleranceFor, unitScale, valuesForPeriod,
} from "../src/retrieve/indicators";

const pnad: IndicatorSeries = {
  code: "desocupacao_pnadc", name: "Taxa de desocupação", aliases: ["desemprego"], unit: "%",
  periodicity: "quarterly", source_name: "IBGE", source_url: "https://sidra.ibge.gov.br/tabela/4099", tier: 1, notes: null,
};

const q = (y: number, qq: number, value: number): IndicatorValue => {
  const m0 = (qq - 1) * 3 + 1;
  const end = new Date(Date.UTC(y, m0 + 2, 0)).toISOString().slice(0, 10);
  return { series_code: pnad.code, period_start: `${y}-${String(m0).padStart(2, "0")}-01`, period_end: end, value, released_at: null };
};

// 2022: 11,1 9,3 8,7 7,9 (média 9,25) · 2023: 8,8 8,0 7,7 7,5 (média 8,0)
const VALUES = [q(2022, 1, 11.1), q(2022, 2, 9.3), q(2022, 3, 8.7), q(2022, 4, 7.9), q(2023, 1, 8.8), q(2023, 2, 8.0), q(2023, 3, 7.7), q(2023, 4, 7.5), q(2024, 1, 7.9)];

const ref = (over: Partial<IndicatorRef>): IndicatorRef => ({ query: "desemprego", period: "2023", claimed_value: 8, unit: "%", kind: "level", ...over });

describe("parsePeriod", () => {
  it("ano, trimestre, mês, intervalo", () => {
    expect(parsePeriod("2023")).toMatchObject({ kind: "year", start: "2023-01-01", end: "2023-12-31" });
    expect(parsePeriod("2023-T4")).toMatchObject({ kind: "quarter", start: "2023-10-01", end: "2023-12-31" });
    expect(parsePeriod("2023Q1")).toMatchObject({ kind: "quarter", start: "2023-01-01", end: "2023-03-31" });
    expect(parsePeriod("2024-02")).toMatchObject({ kind: "month", start: "2024-02-01", end: "2024-02-29" });
    expect(parsePeriod("2019..2022")).toMatchObject({ kind: "range", start: "2019-01-01", end: "2022-12-31" });
    expect(parsePeriod("2023-13")).toBeNull();
    expect(parsePeriod("2023..2019")).toBeNull();
    expect(parsePeriod("ontem")).toBeNull();
  });
});

describe("valuesForPeriod", () => {
  it("série trimestral com período anual ⇒ média anual e último valor", () => {
    const vs = valuesForPeriod(parsePeriod("2023"), VALUES, "quarterly");
    expect(vs).toHaveLength(2);
    expect(vs[0]!.value).toBeCloseTo(8.0);
    expect(vs[0]!.label).toContain("média anual");
    expect(vs[1]!.value).toBe(7.5);
  });
  it("ano incompleto ⇒ só o último dado (média parcial enganaria)", () => {
    const vs = valuesForPeriod(parsePeriod("2024"), VALUES, "quarterly");
    expect(vs).toHaveLength(1);
    expect(vs[0]!.value).toBe(7.9);
  });
  it("trimestre exato", () => {
    expect(valuesForPeriod(parsePeriod("2022-T2"), VALUES, "quarterly")).toEqual([{ label: "abr/2022 a jun/2022", value: 9.3 }]);
  });
  it("sem período ⇒ último dado disponível", () => {
    expect(valuesForPeriod(null, VALUES, "quarterly")[0]).toMatchObject({ value: 7.9 });
  });
  it("série mensal: média do ano só com 12 meses", () => {
    const monthly: IndicatorValue[] = Array.from({ length: 12 }, (_, i) => ({
      series_code: "ipca", period_start: `2023-${String(i + 1).padStart(2, "0")}-01`,
      period_end: `2023-${String(i + 1).padStart(2, "0")}-28`, value: i + 1, released_at: null,
    }));
    const vs = valuesForPeriod(parsePeriod("2023"), monthly, "monthly");
    expect(vs.map((v) => v.value)).toEqual([6.5, 12]);
    expect(valuesForPeriod(parsePeriod("2023"), monthly.slice(0, 11), "monthly").map((v) => v.value)).toEqual([11]);
  });
  it("série anual não responde por mês", () => {
    expect(valuesForPeriod(parsePeriod("2023-05"), VALUES, "annual")).toEqual([]);
  });
});

describe("tolerância", () => {
  it("% ⇒ max(0,3 p.p.; 5% relativo); demais ⇒ 10%", () => {
    expect(toleranceFor(true, 4)).toBe(0.3);
    expect(toleranceFor(true, 20)).toBe(1);
    expect(toleranceFor(false, 1000)).toBe(100);
  });
  it("classify: match / minor (até 2×) / mismatch", () => {
    expect(classify(8.3, 8.0, 0.4)).toBe("match");
    expect(classify(7.7, 8.0, 0.3)).toBe("match"); // borda exata (sem erro de ponto flutuante)
    expect(classify(8.7, 8.0, 0.4)).toBe("minor_mismatch");
    expect(classify(9.0, 8.0, 0.4)).toBe("mismatch");
  });
  it("escala na unidade da série", () => {
    expect(unitScale("mil pessoas")).toEqual({ base: "pessoas", factor: 1e3 });
    expect(unitScale("%")).toEqual({ base: "%", factor: 1 });
  });
});

describe("compareIndicator", () => {
  it("nível anual: aceita média OU último valor", () => {
    expect(compareIndicator(ref({ claimed_value: 8 }), pnad, VALUES).status).toBe("match");
    expect(compareIndicator(ref({ claimed_value: 7.5 }), pnad, VALUES).status).toBe("match");
  });
  it("nível: impreciso e contradito", () => {
    // 2022: média 9,25, último 7,9; afirmou 10 → |10−9,25|=0,75 ≤ 2×0,4625
    expect(compareIndicator(ref({ period: "2022", claimed_value: 10 }), pnad, VALUES).status).toBe("minor_mismatch");
    const c = compareIndicator(ref({ claimed_value: 12 }), pnad, VALUES);
    expect(c.status).toBe("mismatch");
    expect(c.expected_verdict).toBe("contradito");
  });
  it("evidência gerada deterministicamente com fonte e período", () => {
    const c = compareIndicator(ref({ claimed_value: 12 }), pnad, VALUES);
    expect(c.evidence_text).toBe("Série Taxa de desocupação (IBGE): 2023 (média anual) = 8 %");
  });
  it("variação em p.p. (change_abs) e relativa (change_pct)", () => {
    // 2022 → 2023: média 9,25 → 8,0 (−1,25 p.p.; −13,5%); último 7,9 → 7,5 (−0,4 p.p.)
    expect(compareIndicator(ref({ period: "2022..2023", claimed_value: 1.2, unit: "p.p.", kind: "change_abs" }), pnad, VALUES).status).toBe("match");
    expect(compareIndicator(ref({ period: "2022..2023", claimed_value: 5, unit: "p.p.", kind: "change_abs" }), pnad, VALUES).status).toBe("mismatch");
    expect(compareIndicator(ref({ period: "2022..2023", claimed_value: 13.5, unit: "%", kind: "change_pct" }), pnad, VALUES).status).toBe("match");
  });
  it("'caiu 13%' em série percentual considera a leitura relativa", () => {
    expect(compareIndicator(ref({ period: "2022..2023", claimed_value: 13, unit: "%", kind: "change_abs" }), pnad, VALUES).status).toBe("match");
  });
  it("sinal explícito oposto ⇒ contradito", () => {
    const up: IndicatorValue[] = [q(2022, 1, 7), q(2022, 2, 7), q(2022, 3, 7), q(2022, 4, 7), q(2023, 1, 9), q(2023, 2, 9), q(2023, 3, 9), q(2023, 4, 9)];
    expect(compareIndicator(ref({ period: "2022..2023", claimed_value: -2, unit: "p.p.", kind: "change_abs" }), pnad, up).status).toBe("mismatch");
  });
  it("variação sem intervalo, unidade incompatível, sem valor ⇒ no_data", () => {
    expect(compareIndicator(ref({ kind: "change_abs" }), pnad, VALUES).status).toBe("no_data");
    expect(compareIndicator(ref({ unit: "R$" }), pnad, VALUES).status).toBe("no_data");
    expect(compareIndicator(ref({ claimed_value: null }), pnad, VALUES).status).toBe("no_data");
    expect(compareIndicator(ref({ period: "2010" }), pnad, VALUES).status).toBe("no_data");
    expect(compareIndicator(ref({ period: "2019..2023" }), pnad, VALUES).status).toBe("no_data");
  });
  it("máximo no período", () => {
    expect(compareIndicator(ref({ period: "2022", claimed_value: 11, kind: "max" }), pnad, VALUES).status).toBe("match");
  });
  it("série em 'mil pessoas' x afirmação absoluta, tolerância 10%", () => {
    const s: IndicatorSeries = { ...pnad, code: "desocupados", name: "Pessoas desocupadas", unit: "mil pessoas" };
    const vals = [q(2023, 4, 8_100)].map((v) => ({ ...v, series_code: s.code }));
    expect(compareIndicator({ query: "desempregados", period: "2023-T4", claimed_value: 8_500_000, unit: null, kind: "level" }, s, vals).status).toBe("match");
    expect(compareIndicator({ query: "desempregados", period: "2023-T4", claimed_value: 9_500_000, unit: null, kind: "level" }, s, vals).status).toBe("minor_mismatch");
    expect(compareIndicator({ query: "desempregados", period: "2023-T4", claimed_value: 12_000_000, unit: null, kind: "level" }, s, vals).status).toBe("mismatch");
  });
});
