// Parsers SGS/SIDRA e resolução de períodos.
//
// PROVENIÊNCIA DOS FIXTURES
// - sgs_433_ipca_2021.json e sgs_1_dolar_2025-02.json: VALORES REAIS devolvidos pela API
//   do SGS e gravados nas saídas dos notebooks do pacote python-bcb 0.4.0
//   (`sgs.get({'IPCA': 433}, last=5)` → 2021-07..2021-11; `sgs.get({'USDBRL': 1}, last=10)`
//   → 17..28/02/2025), remontados no formato JSON do SGS ([{"data","valor"}]).
//   A API do BCB está bloqueada neste ambiente; rode `indicators --check` para conferir ao vivo.
// - *_formato.sample.json: FORMATO do SIDRA/Agregados v3 (cabeçalho NC/NN/MN/V/DnC/DnN,
//   conforme o pacote ibge-br-mcp), com valores e anos (2030) FICTÍCIOS — servem só para
//   testar o parser. Substitua por respostas reais quando houver acesso.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateMonthly, dateWindows, parseSgs, sgsUrl } from "../src/indicators/sgs";
import { agregadosUrl, apisidraUrl, parseSidra, parseSidraFlat } from "../src/indicators/sidra";
import { monthPeriod, movingQuarterPeriod, quarterPeriod, sgsPeriod, sidraPeriod, yearPeriod } from "../src/indicators/periods";
import { CATALOG, INDICATOR_AGGREGATIONS, activeSeries, toSeriesRow } from "../src/indicators/catalog";
import { crossCheckUnemployment } from "../src/commands/indicators";

const fx = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", f), "utf8")) as unknown;

describe("[RF15] SGS (Banco Central)", () => {
  it("interpreta a resposta real (IPCA 433)", () => {
    expect(parseSgs(fx("sgs_433_ipca_2021.json"))).toEqual([
      { date: "2021-07-01", value: 0.96 },
      { date: "2021-08-01", value: 0.87 },
      { date: "2021-09-01", value: 1.16 },
      { date: "2021-10-01", value: 1.25 },
      { date: "2021-11-01", value: 0.95 },
    ]);
  });
  it("série diária → último valor do mês (dólar, série 1)", () => {
    const obs = parseSgs(fx("sgs_1_dolar_2025-02.json"));
    expect(obs).toHaveLength(10);
    expect(aggregateMonthly(obs, "last")).toEqual([{ date: "2025-02-01", value: 5.8488 }]);
    expect(aggregateMonthly(obs, "mean")[0]!.value).toBeCloseTo(5.74727, 4);
  });
  it("ignora valor vazio e rejeita erro/HTML", () => {
    expect(parseSgs([{ data: "01/01/2024", valor: "" }, { data: "01/02/2024", valor: "0,42" }])).toEqual([
      { date: "2024-02-01", value: 0.42 },
    ]);
    expect(() => parseSgs({ erro: "série inexistente" })).toThrow(/inesperada/);
  });
  it("monta a URL com datas no formato do SGS", () => {
    expect(sgsUrl(433, "2003-01-01", "2026-10-19")).toBe(
      "https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=01%2F01%2F2003&dataFinal=19%2F10%2F2026",
    );
  });
  it("janelas de 3 anos sem sobreposição", () => {
    expect(dateWindows("2019-01-01", "2026-10-19", 3)).toEqual([
      ["2019-01-01", "2021-12-31"],
      ["2022-01-01", "2024-12-31"],
      ["2025-01-01", "2026-10-19"],
    ]);
  });
});

describe("[RF15] SIDRA (IBGE)", () => {
  it("formato flat: acha a dimensão de período pelo cabeçalho e pula '..'", () => {
    expect(parseSidraFlat(fx("sidra_4099_formato.sample.json"))).toEqual([
      { periodCode: "203001", periodLabel: "1º trimestre 2030", value: 11.1, unit: "%" },
      { periodCode: "203002", periodLabel: "2º trimestre 2030", value: 22.2, unit: "%" },
    ]);
  });
  it("trimestre móvel em outra coluna (D3)", () => {
    const obs = parseSidra(fx("sidra_6387_movel_formato.sample.json"));
    expect(obs.map((o) => [o.periodCode, o.value])).toEqual([
      ["203001", 1111],
      ["203002", 2222],
    ]);
  });
  it("formato aninhado da API de agregados v3", () => {
    expect(parseSidra(fx("agregados_nested_formato.sample.json"))).toEqual([
      { periodCode: "203001", periodLabel: "203001", value: 11.1, unit: "%" },
      { periodCode: "203002", periodLabel: "203002", value: 22.2, unit: "%" },
    ]);
  });
  it("cabeçalho sem período ⇒ erro claro", () => {
    expect(() => parseSidraFlat([{ V: "Valor", D1N: "Brasil" }])).toThrow(/período/);
  });
  it("URLs das duas portas", () => {
    const q = { table: "5932", variable: "6561", classification: "c11255/90707" };
    expect(agregadosUrl(q)).toBe(
      "https://servicodados.ibge.gov.br/api/v3/agregados/5932/periodos/all/variaveis/6561?localidades=N1[all]&classificacao=11255[90707]&view=flat",
    );
    expect(apisidraUrl(q)).toBe("https://apisidra.ibge.gov.br/values/t/5932/n1/all/v/6561/p/all/c11255/90707");
    expect(apisidraUrl({ ...q, periods: "-4" })).toContain("/p/last%204/");
  });
});

describe("períodos", () => {
  it("mensal, trimestral, móvel e anual", () => {
    expect(monthPeriod(2024, 2)).toEqual({ period_start: "2024-02-01", period_end: "2024-02-29" });
    expect(quarterPeriod(2024, 2)).toEqual({ period_start: "2024-04-01", period_end: "2024-06-30" });
    expect(quarterPeriod(2024, 4)).toEqual({ period_start: "2024-10-01", period_end: "2024-12-31" });
    expect(movingQuarterPeriod(2024, 9)).toEqual({ period_start: "2024-07-01", period_end: "2024-09-30" });
    expect(movingQuarterPeriod(2024, 1)).toEqual({ period_start: "2023-11-01", period_end: "2024-01-31" });
    expect(yearPeriod(2022)).toEqual({ period_start: "2022-01-01", period_end: "2022-12-31" });
  });
  it("códigos do SIDRA conforme a periodicidade", () => {
    expect(sidraPeriod("202402", "quarterly")).toEqual(quarterPeriod(2024, 2));
    expect(sidraPeriod("202409", "monthly")).toEqual(monthPeriod(2024, 9));
    expect(sidraPeriod("202402", "moving_quarter")).toEqual({ period_start: "2023-12-01", period_end: "2024-02-29" });
    expect(sidraPeriod("2023", "annual")).toEqual(yearPeriod(2023));
    expect(() => sidraPeriod("202405", "quarterly")).toThrow();
    expect(() => sidraPeriod("2024", "monthly")).toThrow();
  });
  it("datas do SGS", () => {
    expect(sgsPeriod("01/07/2021", "monthly")).toEqual(monthPeriod(2021, 7));
    expect(sgsPeriod("01/09/2024", "moving_quarter")).toEqual(movingQuarterPeriod(2024, 9));
    expect(sgsPeriod("01/04/2024", "quarterly")).toEqual(quarterPeriod(2024, 2));
    expect(sgsPeriod("01/01/2020", "annual")).toEqual(yearPeriod(2020));
  });
});

describe("[RF15] catálogo de indicadores", () => {
  it("códigos únicos, aliases, URL pública e tier 1", () => {
    expect(new Set(CATALOG.map((s) => s.code)).size).toBe(CATALOG.length);
    for (const s of CATALOG) {
      expect(s.aliases.length).toBeGreaterThan(0);
      expect(s.source_url).toMatch(/^https?:\/\//);
      expect(s.tier).toBe(1);
      expect(["monthly", "quarterly", "annual", "moving_quarter"]).toContain(s.periodicity);
    }
  });
  it("desemprego ⇔ desocupação nos aliases, numa série só (a móvel responde por mês, trimestre, ano e dado atual)", () => {
    const d = CATALOG.filter((s) => s.code.startsWith("desocupacao"));
    expect(d.length).toBe(2);
    const generic = ["desemprego", "taxa de desemprego", "desocupação", "taxa de desocupação"];
    expect(d.find((s) => s.code === "desocupacao_pnadc_movel")!.aliases).toEqual(expect.arrayContaining(generic));
    // repetidos na trimestral virariam empate sem desempate (as duas respondem pelo ano) ⇒ L2 calada
    for (const a of generic) expect(d.find((s) => s.code === "desocupacao_pnadc_trimestral")!.aliases).not.toContain(a);
  });
  it("ativas têm fonte; pendentes têm motivo e ficam fora por padrão", () => {
    for (const s of activeSeries()) expect(s.fetch.kind).not.toBe("none");
    for (const s of CATALOG.filter((x) => x.fetch.kind === "none")) expect(s.pending).toBeTruthy();
    expect(activeSeries().some((s) => s.pending)).toBe(false);
  });
  it("linha de indicator_series não vaza campos internos (e leva a agregação)", () => {
    expect(Object.keys(toSeriesRow(CATALOG[0]!)).sort()).toEqual(
      ["aggregation", "aliases", "code", "name", "notes", "periodicity", "source_name", "source_url", "tier", "unit"].sort(),
    );
  });
  it("toda série declara como agrega: fluxo soma, acumulado 12m usa dezembro, variação mensal não agrega", () => {
    const by = new Map(CATALOG.map((s) => [s.code, s]));
    for (const s of CATALOG) {
      expect(INDICATOR_AGGREGATIONS).toContain(s.aggregation);
      if (s.periodicity === "annual") expect(s.aggregation).toBe("none");
    }
    expect(by.get("caged_saldo")!.aggregation).toBe("sum");
    expect(by.get("pib_corrente_trimestral")!.aggregation).toBe("sum");
    expect(by.get("ipca_mensal")!.aggregation).toBe("none");
    expect(by.get("ipca_12m")!.aggregation).toBe("accum_12m");
    expect(by.get("primario_12m_pib")!.aggregation).toBe("accum_12m");
    expect(by.get("dlsp_pib")!.aggregation).toBe("last");
    expect(by.get("pib_variacao_trimestral")!.aggregation).toBe("none");
  });
  it("catálogo e pipeline usam o mesmo campo `aggregation` com os mesmos valores", () => {
    const pipeline = readFileSync(join(import.meta.dirname, "../../../packages/pipeline/src/retrieve/indicators.ts"), "utf8");
    const list = (src: string) => src.match(/INDICATOR_AGGREGATIONS: readonly IndicatorAggregation\[\] = (\[[^\]]*\])/)?.[1];
    expect(list(pipeline)).toBeTruthy();
    expect(JSON.parse(list(pipeline)!)).toEqual([...INDICATOR_AGGREGATIONS]);
    expect(pipeline).toMatch(/\.aggregation\b/);
  });
  it("alias repetido entre séries ativas só nas duas do IPCA (empate que a afirmação desempata)", () => {
    const norm = (a: string) => a.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
    const owners = new Map<string, string[]>();
    for (const s of activeSeries()) for (const a of new Set(s.aliases.map(norm))) owners.set(a, [...(owners.get(a) ?? []), s.code]);
    const shared = [...owners].filter(([, codes]) => codes.length > 1);
    expect(shared.map(([a]) => a).sort()).toEqual(["custo de vida", "indice de precos ao consumidor amplo", "inflacao", "ipca"]);
    for (const [, codes] of shared) expect(codes.sort()).toEqual(["ipca_12m", "ipca_mensal"]);
    // "inflação de 2023": a variação mensal não agrega em ano, só o acumulado 12m cabe
    const ipca = activeSeries().filter((s) => s.code.startsWith("ipca"));
    expect(ipca.map((s) => s.aggregation).sort()).toEqual(["accum_12m", "none"]);
  });
  it("acumulado 12m não usa nomes do acumulado NO ANO (jan até o mês, outra medida)", () => {
    const ipca12 = CATALOG.find((s) => s.code === "ipca_12m")!;
    for (const a of ["inflação no ano", "inflação acumulada", "ipca acumulado", "inflação acumulada no ano"]) expect(ipca12.aliases).not.toContain(a);
  });
  it("conferência móvel × trimestral detecta divergência", () => {
    const logs: string[] = [];
    const ctx = { log: (m: unknown) => logs.push(String(m)), warn: (m: unknown) => logs.push(`W ${m}`) };
    const v = (code: string, start: string, value: number) => ({ series_code: code, period_start: start, period_end: start, value, released_at: null });
    const n = crossCheckUnemployment(
      ctx,
      new Map([
        ["desocupacao_pnadc_movel", [v("m", "2030-01-01", 7.0), v("m", "2030-04-01", 6.5), v("m", "2030-02-01", 6.8)]],
        ["desocupacao_pnadc_trimestral", [v("t", "2030-01-01", 7.0), v("t", "2030-04-01", 6.9)]],
      ]),
    );
    expect(n).toBe(1);
    expect(logs.some((l) => l.includes("2 trimestres comparados"))).toBe(true);
  });
});
