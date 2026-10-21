import type { IndicatorRef, IndicatorSeries, IndicatorValue } from "@actually/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TIMEOUTS_MS } from "../src/config";
import { retrieveAll } from "../src/retrieve";
import {
  claimMismatch,
  classify, compareIndicator, parsePeriod, retrieveIndicator, toAggregation, toleranceFor, unitScale, valuesForPeriod,
} from "../src/retrieve/indicators";
import type { PipelineStore } from "../src/store";
import type { ExtractedClaim } from "../src/types";
import { MemoryStore, PNAD, PNAD_VALUES, fakeAnthropic, makeDeps } from "./helpers";

const pnad: IndicatorSeries = {
  code: "desocupacao_pnadc", name: "Taxa de desocupação", aliases: ["desemprego"], unit: "%",
  periodicity: "quarterly", aggregation: "mean_or_last", source_name: "IBGE", source_url: "https://sidra.ibge.gov.br/tabela/4099", tier: 1, notes: null,
};

const q = (y: number, qq: number, value: number, code = pnad.code): IndicatorValue => {
  const m0 = (qq - 1) * 3 + 1;
  const end = new Date(Date.UTC(y, m0 + 2, 0)).toISOString().slice(0, 10);
  return { series_code: code, period_start: `${y}-${String(m0).padStart(2, "0")}-01`, period_end: end, value, released_at: null };
};
const mo = (code: string, y: number, m: number, value: number): IndicatorValue => ({
  series_code: code, period_start: `${y}-${String(m).padStart(2, "0")}-01`,
  period_end: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), value, released_at: null,
});
const months = (code: string, y: number, vs: number[]) => vs.map((v, i) => mo(code, y, i + 1, v));

// 2022: 11,1 9,3 8,7 7,9 (média 9,25) · 2023: 8,8 8,0 7,7 7,5 (média 8,0)
const VALUES = [q(2022, 1, 11.1), q(2022, 2, 9.3), q(2022, 3, 8.7), q(2022, 4, 7.9), q(2023, 1, 8.8), q(2023, 2, 8.0), q(2023, 3, 7.7), q(2023, 4, 7.5), q(2024, 1, 7.9)];

const ref = (over: Partial<IndicatorRef>): IndicatorRef => ({ query: "desemprego", period: "2023", claimed_value: 8, unit: "%", kind: "level", ...over });

// Séries como no catálogo do kb-ingest (apps/kb-ingest/src/indicators/catalog.ts)
const src = { source_name: "IBGE/BCB", source_url: "https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json", tier: 1 as const, notes: null, aliases: [] };
const IPCA_MENSAL: IndicatorSeries = { ...src, code: "ipca_mensal", name: "IPCA — variação mensal", unit: "%", periodicity: "monthly", aggregation: "none" };
const IPCA_12M: IndicatorSeries = { ...src, code: "ipca_12m", name: "IPCA — acumulado em 12 meses", unit: "%", periodicity: "monthly", aggregation: "accum_12m" };
const DLSP: IndicatorSeries = { ...src, code: "dlsp_pib", name: "Dívida líquida do setor público (% do PIB)", unit: "% do PIB", periodicity: "monthly", aggregation: "last" };
const PRIMARIO: IndicatorSeries = { ...src, code: "primario_12m_pib", name: "Resultado primário 12m (% do PIB)", unit: "% do PIB", periodicity: "monthly", aggregation: "accum_12m" };
const RENDIMENTO: IndicatorSeries = { ...src, code: "rendimento_medio_real", name: "Rendimento médio real", unit: "R$", periodicity: "moving_quarter", aggregation: "mean_or_last" };
const CAGED: IndicatorSeries = { ...src, code: "caged_saldo", name: "Novo Caged — saldo de empregos formais no mês", unit: "postos de trabalho", periodicity: "monthly", aggregation: "sum" };
const PIB_CORRENTE: IndicatorSeries = { ...src, code: "pib_corrente_trimestral", name: "PIB a preços correntes (trimestral)", unit: "R$ milhões", periodicity: "quarterly", aggregation: "sum" };
const POP: IndicatorSeries = { ...src, code: "populacao_estimada", name: "População residente estimada", unit: "pessoas", periodicity: "annual", aggregation: "none" };
const DESOC_TRI: IndicatorSeries = { ...pnad, code: "desocupacao_pnadc_trimestral" };
const DESOC_MOV: IndicatorSeries = { ...pnad, code: "desocupacao_pnadc_movel", periodicity: "moving_quarter" };

// IPCA 2025: variação mensal (média ≈ 0,35) e acumulado em 12 meses (dez = 4,26)
const IPCA_MENSAL_2025 = months("ipca_mensal", 2025, [0.16, 1.31, 0.56, 0.43, 0.26, 0.24, 0.26, -0.11, 0.48, 0.09, 0.18, 0.33]);
const IPCA_12M_2025 = months("ipca_12m", 2025, [4.56, 5.06, 5.48, 5.53, 5.32, 5.35, 5.23, 5.13, 5.17, 4.68, 4.46, 4.26]);
// Caged 2024: soma = 1.684.208; dezembro = −535.547
const CAGED_2024 = months("caged_saldo", 2024, [180395, 306111, 244315, 240033, 139505, 201705, 188021, 232513, 247818, 132714, 106625, -535547]);
// PIB nominal 2024 em R$ milhões: soma = 11.741.000 (R$ 11,7 tri)
const PIB_2024 = [q(2024, 1, 2_766_000, PIB_CORRENTE.code), q(2024, 2, 2_915_000, PIB_CORRENTE.code), q(2024, 3, 3_012_000, PIB_CORRENTE.code), q(2024, 4, 3_048_000, PIB_CORRENTE.code)];
const POP_2025: IndicatorValue[] = [{ series_code: POP.code, period_start: "2025-01-01", period_end: "2025-12-31", value: 213_421_037, released_at: null }];

/**
 * find_indicator falso com os scores que o pg_trgm real dá (ver comentários de cada caso).
 * `withoutColumn`: banco sem a migration 20261019000007 (a RPC nem devolve `aggregation`).
 */
function fakeStore(matches: [IndicatorSeries, number][], values: Record<string, IndicatorValue[]>, opts: { withoutColumn?: boolean } = {}) {
  const valueCalls: string[] = [];
  const store = {
    async findIndicator() {
      return matches.map(([s, score]) => {
        const row: Record<string, unknown> = {
          code: s.code, name: s.name, unit: s.unit, periodicity: s.periodicity, aggregation: s.aggregation,
          source_name: s.source_name, source_url: s.source_url, tier: s.tier, score,
        };
        if (opts.withoutColumn) delete row.aggregation;
        return row;
      });
    },
    async indicatorValues(code: string) {
      valueCalls.push(code);
      return values[code] ?? [];
    },
  } as unknown as PipelineStore;
  return { store, valueCalls };
}

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
    const vs = valuesForPeriod(parsePeriod("2023"), VALUES, "quarterly", "mean_or_last");
    expect(vs).toHaveLength(2);
    expect(vs[0]!.value).toBeCloseTo(8.0);
    expect(vs[0]!.label).toContain("média anual");
    expect(vs[1]!.value).toBe(7.5);
  });
  it("ano incompleto ⇒ só o último dado (média parcial enganaria)", () => {
    const vs = valuesForPeriod(parsePeriod("2024"), VALUES, "quarterly", "mean_or_last");
    expect(vs).toHaveLength(1);
    expect(vs[0]!.value).toBe(7.9);
  });
  it("trimestre exato", () => {
    expect(valuesForPeriod(parsePeriod("2022-T2"), VALUES, "quarterly", "mean_or_last")).toEqual([{ label: "abr/2022 a jun/2022", value: 9.3 }]);
  });
  it("sem período ⇒ último dado disponível", () => {
    expect(valuesForPeriod(null, VALUES, "quarterly", "mean_or_last")[0]).toMatchObject({ value: 7.9 });
  });
  it("série mensal: média do ano só com 12 meses", () => {
    const monthly = months("ipca", 2023, Array.from({ length: 12 }, (_, i) => i + 1));
    const vs = valuesForPeriod(parsePeriod("2023"), monthly, "monthly", "mean_or_last");
    expect(vs.map((v) => v.value)).toEqual([6.5, 12]);
    expect(valuesForPeriod(parsePeriod("2023"), monthly.slice(0, 11), "monthly", "mean_or_last").map((v) => v.value)).toEqual([11]);
  });
  it("série anual não responde por mês", () => {
    expect(valuesForPeriod(parsePeriod("2023-05"), VALUES, "annual", "none")).toEqual([]);
  });
});

describe("[RF03] tolerância", () => {
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

describe("[RF03] compareIndicator (L2 determinístico)", () => {
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
  it("[RF03] máximo/mínimo divergente ⇒ no_data (extremo_inconclusivo), nunca contradito determinístico", () => {
    for (const kind of ["max", "min"] as const) {
      const r = compareIndicator(ref({ period: "2022", claimed_value: 30, kind }), pnad, VALUES);
      expect(r).toMatchObject({ status: "no_data", expected_verdict: null });
    }
    const caged = compareIndicator({ query: "geração de empregos", period: "2024", claimed_value: 2_700_000, unit: null, kind: "max" }, CAGED, CAGED_2024);
    expect(caged.status === "match" || caged.status === "no_data").toBe(true);
  });
  it("série em 'mil pessoas' x afirmação absoluta, tolerância 10%", () => {
    const s: IndicatorSeries = { ...pnad, code: "desocupados", name: "Pessoas desocupadas", unit: "mil pessoas" };
    const vals = [q(2023, 4, 8_100)].map((v) => ({ ...v, series_code: s.code }));
    expect(compareIndicator({ query: "desempregados", period: "2023-T4", claimed_value: 8_500_000, unit: null, kind: "level" }, s, vals).status).toBe("match");
    expect(compareIndicator({ query: "desempregados", period: "2023-T4", claimed_value: 9_500_000, unit: null, kind: "level" }, s, vals).status).toBe("minor_mismatch");
    expect(compareIndicator({ query: "desempregados", period: "2023-T4", claimed_value: 12_000_000, unit: null, kind: "level" }, s, vals).status).toBe("mismatch");
  });
});

describe("[RF03] L2: escolha inequívoca da série (retrieveIndicator)", () => {
  const inflacao = (over: Partial<IndicatorRef>): IndicatorRef => ({ query: "inflação", period: "2025", claimed_value: 4.3, unit: "%", kind: "level", ...over });
  const IPCA_VALUES = { ipca_mensal: IPCA_MENSAL_2025, ipca_12m: IPCA_12M_2025 };

  it("'inflação de 2025 foi 4,3%': alias nas duas séries do IPCA ⇒ só o acumulado 12m cabe no ano (dezembro) ⇒ confirmado", async () => {
    const { store, valueCalls } = fakeStore([[IPCA_MENSAL, 1], [IPCA_12M, 1]], IPCA_VALUES);
    const r = await retrieveIndicator(inflacao({}), store);
    expect(r.comparison).toMatchObject({ status: "match", expected_verdict: "confirmado", series_code: "ipca_12m", actual: 4.26 });
    expect(r.candidate?.text).toContain("2025 (12 meses até dez/2025) = 4,26 %");
    expect(valueCalls).toEqual(["ipca_12m"]);
  });

  it("cenário da falha: 'inflação' só na mensal (pg_trgm 1,0 × 0,6) ⇒ silêncio, nunca 'contradito' pela média mensal 0,35", async () => {
    const { store, valueCalls } = fakeStore([[IPCA_MENSAL, 1], [IPCA_12M, 0.6]], IPCA_VALUES);
    const r = await retrieveIndicator(inflacao({}), store);
    expect(r.comparison).toMatchObject({ status: "no_data", expected_verdict: null, reason: "periodo_incompativel" });
    expect(r.candidate).toBeNull();
    expect(valueCalls).toEqual([]);
  });

  it("'inflação de março' cabe nas duas leituras (mês × 12 meses) ⇒ série ambígua ⇒ silêncio", async () => {
    const { store, valueCalls } = fakeStore([[IPCA_MENSAL, 1], [IPCA_12M, 1]], IPCA_VALUES);
    for (const period of ["2025-03", null]) {
      const r = await retrieveIndicator(inflacao({ period, claimed_value: 0.56 }), store);
      expect(r.comparison).toMatchObject({ status: "no_data", reason: "serie_ambigua" });
      expect(r.candidate).toBeNull();
    }
    expect(valueCalls).toEqual([]);
  });

  it("'dívida pública' → DLSP (0,71) e 'salário mínimo' → rendimento médio (0,47): aproximado demais ⇒ silêncio", async () => {
    // scores do find_indicator real (pg_trgm) sobre o catálogo ativo
    const divida = fakeStore([[DLSP, 0.714], [PRIMARIO, 0.304]], { dlsp_pib: months("dlsp_pib", 2025, Array(12).fill(65)) });
    const r1 = await retrieveIndicator({ query: "dívida pública", period: "2025", claimed_value: 77, unit: "% do PIB", kind: "level" }, divida.store);
    expect(r1).toMatchObject({ comparison: { status: "no_data", reason: "serie_ambigua" }, candidate: null });
    const salario = fakeStore([[RENDIMENTO, 0.474]], {});
    const r2 = await retrieveIndicator({ query: "salário mínimo", period: null, claimed_value: 1518, unit: "R$", kind: "level" }, salario.store);
    expect(r2).toMatchObject({ comparison: { status: "no_data", reason: "serie_ambigua" }, candidate: null });
    expect([...divida.valueCalls, ...salario.valueCalls]).toEqual([]);
  });

  it("aproximado alto só vale com margem clara sobre a 2ª série", async () => {
    const claim: IndicatorRef = { query: "geração de empregos formais", period: "2024", claimed_value: 1_700_000, unit: null, kind: "level" };
    const alone = fakeStore([[CAGED, 0.85], [DESOC_MOV, 0.3]], { caged_saldo: CAGED_2024 });
    expect((await retrieveIndicator(claim, alone.store)).comparison).toMatchObject({ status: "match", series_code: "caged_saldo" });
    const close = fakeStore([[DESOC_TRI, 0.85], [DESOC_MOV, 0.84]], {});
    expect((await retrieveIndicator(ref({ query: "taxa de desemprego no país" }), close.store)).comparison).toMatchObject({ reason: "serie_ambigua" });
  });

  it("empate exato entre duas séries que respondem pelo mesmo período ⇒ silêncio (o catálogo não pode repetir o alias)", async () => {
    const { store } = fakeStore([[DESOC_TRI, 1], [DESOC_MOV, 1]], {});
    expect((await retrieveIndicator(ref({}), store)).comparison).toMatchObject({ status: "no_data", reason: "serie_ambigua" });
  });

  it("nome exato manda: série aproximada não entra no lugar da exata que não cabe na afirmação", async () => {
    // "o IPCA mensal de 2025 foi 4,3%": a mensal (nomeada exatamente) não agrega em ano; o
    // acumulado 12m a 0,8 caberia, mas não foi a série dita ⇒ silêncio, sem carregar valores
    const { store, valueCalls } = fakeStore([[IPCA_MENSAL, 1], [IPCA_12M, 0.8]], IPCA_VALUES);
    const r = await retrieveIndicator(inflacao({ query: "ipca mensal" }), store);
    expect(r).toMatchObject({ comparison: { status: "no_data", reason: "periodo_incompativel", series_code: "ipca_mensal" }, candidate: null });
    expect(valueCalls).toEqual([]);
  });

  it("nome exato que cabe vence a aproximada que também caberia (mesma medida, 0,79)", async () => {
    const movel = VALUES.map((v) => ({ ...v, series_code: DESOC_MOV.code }));
    const { store, valueCalls } = fakeStore([[DESOC_MOV, 1], [DESOC_TRI, 0.79]], { [DESOC_MOV.code]: movel });
    const r = await retrieveIndicator(ref({ query: "taxa de desocupação" }), store);
    expect(r.comparison).toMatchObject({ status: "match", series_code: DESOC_MOV.code });
    expect(valueCalls).toEqual([DESOC_MOV.code]);
  });

  it("'desempregados' é contagem, não taxa: sem alias na série em %, só casa aproximado (0,56) ⇒ silêncio", async () => {
    // scores reais do find_indicator sobre o catálogo ativo (sem "desempregados" na trimestral)
    const { store, valueCalls } = fakeStore([[DESOC_MOV, 0.563], [DESOC_TRI, 0.333]], { [DESOC_MOV.code]: VALUES });
    const r = await retrieveIndicator({ query: "desempregados", period: null, claimed_value: 8.5, unit: null, kind: "level" }, store);
    expect(r).toMatchObject({ comparison: { status: "no_data", reason: "serie_ambigua" }, candidate: null });
    expect(valueCalls).toEqual([]);
  });
});

describe("[RF03] L2: série sem agregação declarada ⇒ silêncio (banco sem a migration ou ainda não recarregado)", () => {
  // Banco com o catálogo ANTIGO: "inflação" só na variação mensal (pg_trgm 1,0 × 0,6 no acumulado)
  // e Caged com "empregos formais" (1,0). Sem a agregação, "none" leria o último ponto e acusaria.
  const IPCA_VALUES = { ipca_mensal: IPCA_MENSAL_2025, ipca_12m: IPCA_12M_2025 };
  const inflacaoHoje: IndicatorRef = { query: "inflação", period: null, claimed_value: 4.5, unit: "%", kind: "level" };
  const empregos: IndicatorRef = { query: "empregos formais", period: null, claimed_value: 1_700_000, unit: null, kind: "level" };
  const undeclared = (s: IndicatorSeries): IndicatorSeries => ({ ...s, aggregation: null });

  it("'A inflação está em 4,5%' sem a coluna ⇒ no_data, nunca 'dez/2025 (último dado disponível) = 0,33 %' contradito", async () => {
    const { store, valueCalls } = fakeStore([[IPCA_MENSAL, 1], [IPCA_12M, 0.6]], IPCA_VALUES, { withoutColumn: true });
    const r = await retrieveIndicator(inflacaoHoje, store);
    expect(r).toMatchObject({ comparison: { status: "no_data", expected_verdict: null, reason: "serie_sem_agregacao", series_code: "ipca_mensal" }, candidate: null });
    expect(valueCalls).toEqual([]);
  });

  it("'Criamos 1,7 milhão de empregos formais' sem a coluna ⇒ no_data, nunca 'dez/2024 = -535.547' contradito", async () => {
    const { store, valueCalls } = fakeStore([[CAGED, 1]], { caged_saldo: CAGED_2024 }, { withoutColumn: true });
    const r = await retrieveIndicator(empregos, store);
    expect(r).toMatchObject({ comparison: { status: "no_data", reason: "serie_sem_agregacao" }, candidate: null });
    expect(valueCalls).toEqual([]);
  });

  it("coluna criada mas linha ainda null (kb-ingest não rodou depois da migration) ⇒ mesmo silêncio, com ou sem período", async () => {
    const { store } = fakeStore([[undeclared(IPCA_MENSAL), 1], [undeclared(IPCA_12M), 0.6]], IPCA_VALUES);
    for (const period of [null, "2025", "2025-03"]) {
      expect((await retrieveIndicator({ ...inflacaoHoje, period }, store)).comparison).toMatchObject({ status: "no_data", reason: "serie_sem_agregacao" });
    }
    const pnadNull = fakeStore([[undeclared(pnad), 1]], { [pnad.code]: VALUES });
    expect((await retrieveIndicator(ref({ claimed_value: 12 }), pnadNull.store)).comparison).toMatchObject({ status: "no_data", reason: "serie_sem_agregacao" });
  });

  it("uma série sem agregação entre as que empatam basta para calar (não escolhe a outra por exclusão)", async () => {
    const { store, valueCalls } = fakeStore([[undeclared(IPCA_MENSAL), 1], [IPCA_12M, 1]], IPCA_VALUES);
    const r = await retrieveIndicator({ ...inflacaoHoje, period: "2025", claimed_value: 4.3 }, store);
    expect(r).toMatchObject({ comparison: { status: "no_data", reason: "serie_sem_agregacao", series_code: "ipca_mensal" }, candidate: null });
    expect(valueCalls).toEqual([]);
  });

  it("compareIndicator com série sem agregação ⇒ no_data; 'none' só vale explícito", () => {
    expect(compareIndicator(inflacaoHoje, undeclared(IPCA_MENSAL), IPCA_MENSAL_2025)).toMatchObject({ status: "no_data", reason: "serie_sem_agregacao" });
    expect(compareIndicator(empregos, undeclared(CAGED), CAGED_2024)).toMatchObject({ status: "no_data", reason: "serie_sem_agregacao" });
    expect(toAggregation(undefined)).toBeNull();
    expect(toAggregation(null)).toBeNull();
    expect(toAggregation("soma")).toBeNull();
    expect(toAggregation("none")).toBe("none");
    expect(toAggregation("sum")).toBe("sum");
  });
});

describe("[RF03] L2: agregação conforme o tipo de série", () => {
  it("fluxo (Caged): ano = SOMA dos 12 meses — 1,7 mi em 2024 é verdade, não 'contradito' por dezembro", () => {
    const c = compareIndicator({ query: "empregos formais", period: "2024", claimed_value: 1_700_000, unit: null, kind: "level" }, CAGED, CAGED_2024);
    expect(c).toMatchObject({ status: "match", expected_verdict: "confirmado", actual: 1_684_208 });
    expect(c.evidence_text).toContain("2024 (soma de 12 meses) = 1.684.208 postos de trabalho");
    // "1,7 milhão" com a escala na unidade
    expect(compareIndicator({ query: "empregos formais", period: "2024", claimed_value: 1.7, unit: "milhão", kind: "level" }, CAGED, CAGED_2024).status).toBe("match");
    // trimestre = soma dos 3 meses
    expect(compareIndicator({ query: "caged", period: "2024-T1", claimed_value: 730_821, unit: null, kind: "level" }, CAGED, CAGED_2024).status).toBe("match");
    // total errado continua contradito
    expect(compareIndicator({ query: "caged", period: "2024", claimed_value: 3_000_000, unit: null, kind: "level" }, CAGED, CAGED_2024).status).toBe("mismatch");
  });

  it("fluxo: ano incompleto ou sem período ⇒ no_data (o último mês não é o total afirmado)", () => {
    const partial = CAGED_2024.slice(0, 9);
    expect(compareIndicator({ query: "caged", period: "2024", claimed_value: 1_700_000, unit: null, kind: "level" }, CAGED, partial)).toMatchObject({ status: "no_data" });
    expect(compareIndicator({ query: "caged", period: null, claimed_value: 1_700_000, unit: null, kind: "level" }, CAGED, CAGED_2024)).toMatchObject({ status: "no_data", reason: "periodo_incompativel" });
  });

  it("PIB nominal em 'R$ milhões': ano = soma dos trimestres e escala 1e6 (R$ 11,7 tri em 2024)", () => {
    expect(unitScale("R$ milhões")).toEqual({ base: "R$", factor: 1e6 });
    const year = compareIndicator({ query: "valor do PIB", period: "2024", claimed_value: 11.7, unit: "trilhões de reais", kind: "level" }, PIB_CORRENTE, PIB_2024);
    expect(year).toMatchObject({ status: "match", actual: 11_741_000_000_000 });
    expect(compareIndicator({ query: "valor do PIB", period: "2024", claimed_value: 11.7e12, unit: "R$", kind: "level" }, PIB_CORRENTE, PIB_2024).status).toBe("match");
    expect(compareIndicator({ query: "valor do PIB", period: "2024-T4", claimed_value: 3.05, unit: "R$ trilhões", kind: "level" }, PIB_CORRENTE, PIB_2024).status).toBe("match");
  });

  it("variação mensal (IPCA 433) não agrega: ano/trimestre ⇒ no_data; mês exato ⇒ compara", () => {
    expect(compareIndicator({ query: "ipca mensal", period: "2025", claimed_value: 4.3, unit: "%", kind: "level" }, IPCA_MENSAL, IPCA_MENSAL_2025))
      .toMatchObject({ status: "no_data", reason: "periodo_incompativel" });
    expect(compareIndicator({ query: "ipca mensal", period: "2025-T1", claimed_value: 2, unit: "%", kind: "level" }, IPCA_MENSAL, IPCA_MENSAL_2025).status).toBe("no_data");
    expect(compareIndicator({ query: "ipca mensal", period: "2025-03", claimed_value: 0.56, unit: "%", kind: "level" }, IPCA_MENSAL, IPCA_MENSAL_2025).status).toBe("match");
  });

  it("acumulado 12m: ano civil = dezembro; trimestre não é leitura dessa série", () => {
    expect(compareIndicator({ query: "inflação anual", period: "2025", claimed_value: 4.26, unit: "%", kind: "level" }, IPCA_12M, IPCA_12M_2025)).toMatchObject({ status: "match", actual: 4.26 });
    expect(compareIndicator({ query: "inflação anual", period: "2025", claimed_value: 10, unit: "%", kind: "level" }, IPCA_12M, IPCA_12M_2025).status).toBe("mismatch");
    expect(compareIndicator({ query: "inflação anual", period: "2025-T1", claimed_value: 5.48, unit: "%", kind: "level" }, IPCA_12M, IPCA_12M_2025).status).toBe("no_data");
    // ano sem dezembro ⇒ sem dado
    expect(compareIndicator({ query: "inflação anual", period: "2025", claimed_value: 4.26, unit: "%", kind: "level" }, IPCA_12M, IPCA_12M_2025.slice(0, 11)).status).toBe("no_data");
  });

  it("estoque ('last'): ano = ponto do fim do período, sem média", () => {
    const dlsp = months("dlsp_pib", 2023, [56, 56.5, 57, 57.2, 58, 58.3, 59, 59.5, 60, 60.2, 60.5, 60.9]);
    expect(valuesForPeriod(parsePeriod("2023"), dlsp, "monthly", "last")).toEqual([{ label: "dez/2023 (fim de 2023)", value: 60.9 }]);
    expect(valuesForPeriod(parsePeriod("2023-T2"), dlsp, "monthly", "last")).toEqual([{ label: "jun/2023 (fim de 2º tri/2023)", value: 58.3 }]);
  });
});

describe("[RF03] L2: escala do valor afirmado ('213' + 'milhões')", () => {
  const pop = (claimed_value: number, unit: string | null): IndicatorRef => ({ query: "população", period: null, claimed_value, unit, kind: "level" });

  it("unitScale entende moeda + multiplicador e multiplicador solto", () => {
    expect(unitScale("US$ bilhões")).toEqual({ base: "US$", factor: 1e9 });
    expect(unitScale("milhões de reais")).toEqual({ base: "R$", factor: 1e6 });
    expect(unitScale("R$ bi")).toEqual({ base: "R$", factor: 1e9 });
    expect(unitScale("milhões")).toEqual({ base: null, factor: 1e6 });
    expect(unitScale("milhões de habitantes")).toEqual({ base: "habitantes", factor: 1e6 });
    expect(unitScale(null)).toEqual({ base: null, factor: 1 });
    // "mil" no meio não é escala
    expect(unitScale("por 100 mil hab.").factor).toBe(1);
  });

  it("'213 milhões de habitantes' é verdade com o multiplicador na unidade (antes: 213 × 213.421.037 ⇒ contradito)", () => {
    expect(compareIndicator(pop(213, "milhões"), POP, POP_2025)).toMatchObject({ status: "match", claimed: 213_000_000 });
    expect(compareIndicator(pop(213, "milhões de habitantes"), POP, POP_2025).status).toBe("match");
    // extrator que já aplicou o multiplicador e repetiu a palavra na unidade
    expect(compareIndicator(pop(213_000_000, "milhões"), POP, POP_2025).status).toBe("match");
  });

  it("número que só bate trocando a escala, sem unidade ⇒ no_data (escala_incerta), nunca contradito", () => {
    expect(compareIndicator(pop(213, null), POP, POP_2025)).toMatchObject({ status: "no_data", expected_verdict: null, reason: "escala_incerta" });
    expect(compareIndicator(pop(213, "mil"), POP, POP_2025)).toMatchObject({ status: "no_data", reason: "escala_incerta" });
  });

  it("[RF03] escala perdida que, corrigida, fica só imprecisa ⇒ escala_incerta (nunca contradito sobre o número sem escala)", () => {
    expect(compareIndicator(pop(180, null), POP, POP_2025)).toMatchObject({ status: "no_data", reason: "escala_incerta" });
    expect(compareIndicator(pop(180, "habitantes"), POP, POP_2025)).toMatchObject({ status: "no_data", reason: "escala_incerta" });
    // com a escala dita, a comparação vale normalmente (impreciso)
    expect(compareIndicator(pop(180, "milhões"), POP, POP_2025).status).toBe("minor_mismatch");
  });

  it("valor errado com escala certa continua contradito", () => {
    expect(compareIndicator(pop(300, "milhões"), POP, POP_2025)).toMatchObject({ status: "mismatch", expected_verdict: "contradito", claimed: 300_000_000 });
  });

  it("contagem não é taxa: '5 milhões' ou 8.500.000 sem unidade sobre série em % ⇒ unidade incompatível", () => {
    expect(compareIndicator(ref({ claimed_value: 5, unit: "milhões" }), pnad, VALUES)).toMatchObject({ status: "no_data", reason: "unidade_incompativel" });
    expect(compareIndicator(ref({ claimed_value: 8_500_000, unit: null }), pnad, VALUES)).toMatchObject({ status: "no_data", reason: "unidade_incompativel" });
  });
});

describe("[RF03] retrieveAll: comparação L2 só entra com a camada L2 concluída no prazo", () => {
  afterEach(() => vi.useRealTimers());
  const claim: ExtractedClaim = {
    text_original: "o desemprego em 2023 foi de 12%", text_normalized: "A taxa de desemprego no Brasil em 2023 foi de 12%.",
    topic: "economia", kind: "estatistica", measurable: null, numbers: [], time_reference: "2023",
    indicator: { query: "desemprego", period: "2023", claimed_value: 12, unit: "%", kind: "level" },
    reference: null,
  };
  const anthropic = fakeAnthropic({ extract: () => ({ hang: true }), verify: () => ({ hang: true }) });

  it("L2 estoura o timeout e termina enquanto L1/L3 ainda rodam ⇒ sem comparação e sem candidato L2", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = new MemoryStore({ series: [PNAD], values: PNAD_VALUES }, {}, {
      findIndicator: TIMEOUTS_MS.L2 + 200, matchFactchecks: TIMEOUTS_MS.L2 + 400, matchChunks: TIMEOUTS_MS.L2 + 400,
    });
    const p = retrieveAll(makeDeps({ store, anthropic }), claim, [0.1, 0.2]);
    await vi.advanceTimersByTimeAsync(TIMEOUTS_MS.L3 + 1_000);
    const r = await p;
    expect(r.layers.find((l) => l.layer === "L2")?.error).toMatch(/timeout/);
    expect(r.candidates.some((c) => c.layer === "L2")).toBe(false);
    expect(r.comparison).toBeNull();
  });

  it("L2 no prazo ⇒ comparação junto com o candidato L2", async () => {
    const store = new MemoryStore({ series: [PNAD], values: PNAD_VALUES });
    const r = await retrieveAll(makeDeps({ store, anthropic }), claim, [0.1, 0.2]);
    expect(r.comparison).toMatchObject({ status: "mismatch", series_code: PNAD.code });
    expect(r.candidates.find((c) => c.layer === "L2")?.comparison).toBe(r.comparison);
  });
});

describe("[RF03] séries que já são taxa de variação (PIB)", () => {
  const pib = { ...PNAD, code: "pib_variacao_anual", name: "PIB — variação real anual", periodicity: "annual" as const, aggregation: "mean_or_last" as const };
  const ref = (over: Partial<IndicatorRef>): IndicatorRef => ({ query: "pib", period: "2023", claimed_value: 3, unit: "%", kind: "level", ...over });
  it("variação entre duas taxas (\"cresceu 50% de 2022 para 2023\") não é comparada", () => {
    expect(claimMismatch(ref({ kind: "change_pct", period: "2022..2023", claimed_value: 50 }), pib)).toBe("serie_so_nivel");
    expect(claimMismatch(ref({ kind: "change_abs", period: "2022..2023", claimed_value: 1 }), pib)).toBe("serie_so_nivel");
  });
  it("sem período (\"o PIB está crescendo 3%\") não é comparada com o último ano", () => {
    expect(claimMismatch(ref({ period: null }), pib)).toBe("periodo_obrigatorio");
  });
  it("com o ano, compara", () => {
    expect(claimMismatch(ref({}), pib)).toBeNull();
  });
});
