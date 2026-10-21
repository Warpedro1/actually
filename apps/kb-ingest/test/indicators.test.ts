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
// - sidra_6381_movel_2025-12_2026-06.json: VALORES REAIS da tabela 6381 (v4099), iguais nos
//   CSVs que dois projetos atualizam direto do apisidra (github.com/guilhermekleinmartins-creator/
//   indicador-made data/pnadc.csv e github.com/alexandrepsaldanha/monitor-mercado-trabalho
//   data/indicadores.csv, com os rótulos "out-nov-dez 2025"...); 5,1 (dez), 5,8 (fev), 6,1 (mar)
//   e 5,6 (mai) conferem com as divulgações do IBGE. O cabeçalho segue o formato flat acima, com
//   o período em D3 como o fetch_sidra.py do indicador-made lê.
// - sgs_24369_desocupacao_2025-12_2026-06.json: os MESMOS valores remontados no formato do SGS
//   (não é resposta gravada da 24369): serve para provar que principal e reserva dão as mesmas linhas.
// - sgs_7326_pib_anual_2003-2025.json: VALORES REAIS da série 7326 do SGS gravados por
//   github.com/rlavourinha/monitor-cobertura (coletar.py → bcb.sgs(7326) → data/realizado.json),
//   remontados no formato JSON do SGS.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateMonthly, dateWindows, parseSgs, SGS_NON_JSON_RETRIES, sgsUrl } from "../src/indicators/sgs";
import { agregadosUrl, apisidraUrl, parseSidra, parseSidraFlat } from "../src/indicators/sidra";
import { monthPeriod, movingQuarterPeriod, quarterPeriod, sgsPeriod, sidraPeriod, yearPeriod } from "../src/indicators/periods";
import { INDICATOR_AGGREGATIONS, lookupSource, type IndicatorValue } from "@actually/db";
import { CATALOG, activeSeries, describeFetch, toSeriesRow, type CatalogSeries } from "../src/indicators/catalog";
import { manualPeriod, parseManualSeries, manualSeriesRaw, sourceProblem } from "../src/indicators/manual";
import {
  compareSources, crossCheckUnemployment, loadFrom, loadSeries, loadSeriesValues, runIndicators, withMigrationHint, type Fetchers,
} from "../src/commands/indicators";
import { seriesState } from "../src/commands/status";
import { MANUAL_SERIES_RAW } from "../src/generated/sources";
import { fetchJson } from "../src/lib/http";
import type { Ctx } from "../src/lib/ctx";

const fx = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", f), "utf8")) as unknown;
const serie = (code: string) => CATALOG.find((s) => s.code === code)!;

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
  it("linha de indicator_series não vaza campos internos (fetch, reserva, conferência) e leva a agregação", () => {
    // todas: a desocupação móvel tem `fallback`, e o teste de aceitação insere a linha inteira no banco
    for (const s of CATALOG) {
      expect(Object.keys(toSeriesRow(s)).sort()).toEqual(
        ["aggregation", "aliases", "code", "name", "notes", "periodicity", "source_name", "source_url", "tier", "unit"].sort(),
      );
    }
  });
  it("toda série declara como agrega: fluxo soma, acumulado 12m usa dezembro, variação mensal não agrega, taxa anual tira média", () => {
    const by = new Map(CATALOG.map((s) => [s.code, s]));
    for (const s of CATALOG) {
      expect(INDICATOR_AGGREGATIONS).toContain(s.aggregation);
      // série anual: só "none" (nível/contagem) ou "mean_or_last" (taxa: média de vários anos ou o último)
      if (s.periodicity === "annual") expect(["none", "mean_or_last"]).toContain(s.aggregation);
    }
    // "cresceu X% ao ano no governo Lula" = média das taxas anuais; soma de taxas não é nada
    expect(by.get("pib_variacao_anual")!.aggregation).toBe("mean_or_last");
    expect(by.get("carga_tributaria_pib")!.aggregation).toBe("mean_or_last");
    expect(by.get("pib_per_capita")!.aggregation).toBe("none");
    expect(by.get("populacao_estimada")!.aggregation).toBe("none");
    expect(by.get("caged_saldo")!.aggregation).toBe("sum");
    expect(by.get("pib_corrente_trimestral")!.aggregation).toBe("sum");
    expect(by.get("ipca_mensal")!.aggregation).toBe("none");
    expect(by.get("ipca_12m")!.aggregation).toBe("accum_12m");
    expect(by.get("primario_12m_pib")!.aggregation).toBe("accum_12m");
    expect(by.get("dlsp_pib")!.aggregation).toBe("last");
    expect(by.get("pib_variacao_trimestral")!.aggregation).toBe("none");
  });
  it("série em % não tem alias de contagem ('desempregados', 'desocupados'): 8,5 milhões viraria 8,5%", () => {
    for (const s of CATALOG.filter((x) => x.unit.startsWith("%"))) {
      for (const a of ["desempregados", "desocupados", "pessoas desocupadas", "número de desempregados"]) expect(s.aliases).not.toContain(a);
    }
  });
  it("alias repetido entre séries ativas só nos pares do IPCA e do PIB (empate que a afirmação desempata)", () => {
    const norm = (a: string) => a.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
    const owners = new Map<string, string[]>();
    for (const s of activeSeries()) for (const a of new Set(s.aliases.map(norm))) owners.set(a, [...(owners.get(a) ?? []), s.code]);
    const shared = new Map([...owners].filter(([, codes]) => codes.length > 1).map(([a, codes]) => [a, codes.sort()]));
    const ipcaPair = ["ipca_12m", "ipca_mensal"];
    const pibPair = ["pib_variacao_anual", "pib_variacao_trimestral"];
    expect([...shared.keys()].sort()).toEqual([
      "crescimento da economia", "crescimento do pib", "custo de vida", "indice de precos ao consumidor amplo", "inflacao", "ipca", "pib", "variacao do pib",
    ]);
    for (const a of ["custo de vida", "indice de precos ao consumidor amplo", "inflacao", "ipca"]) expect(shared.get(a)).toEqual(ipcaPair);
    for (const a of ["crescimento da economia", "crescimento do pib", "pib", "variacao do pib"]) expect(shared.get(a)).toEqual(pibPair);
    // "inflação de 2023": a variação mensal não agrega em ano, só o acumulado 12m cabe
    const ipca = activeSeries().filter((s) => s.code.startsWith("ipca"));
    expect(ipca.map((s) => s.aggregation).sort()).toEqual(["accum_12m", "none"]);
    // "o PIB cresceu 3,4% em 2024": a trimestral (none) não responde por ano; "no 2º trimestre": a anual
    // não responde por trimestre nem mês. Sem período, as duas cabem ⇒ empate ⇒ silêncio.
    const trim = serie("pib_variacao_trimestral");
    const anual = serie("pib_variacao_anual");
    expect([trim.periodicity, trim.aggregation]).toEqual(["quarterly", "none"]);
    expect(anual.periodicity).toBe("annual");
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

describe("[RF15] L2 no banco: agregação declarada (migration 20261019000007)", () => {
  it("banco sem a coluna `aggregation`: a carga para logo, com o caminho da migration, sem buscar valores", async () => {
    const upserts: string[] = [];
    const ctx = {
      dryRun: false, verbose: false, log: () => {}, warn: () => {},
      db: {
        from: (table: string) => ({
          upsert: async () => {
            upserts.push(table);
            return { error: { message: "Could not find the 'aggregation' column of 'indicator_series' in the schema cache" } };
          },
        }),
      },
    } as unknown as Ctx;
    await expect(runIndicators(ctx, { only: ["ipca_12m"] })).rejects.toThrow(/20261019000007_indicator_aggregation\.sql/);
    expect(upserts).toEqual(["indicator_series"]);
    // outros erros passam sem a dica
    expect(withMigrationHint(new Error("upsert indicator_series: timeout")).message).toBe("upsert indicator_series: timeout");
  });

  it("status aponta série sem agregação (anterior à coluna) ou com agregação/aliases antigos: rodar `indicators`", () => {
    const s = CATALOG.find((x) => x.code === "ipca_mensal")!;
    expect(seriesState(s, undefined)).toBe("não carregada");
    expect(seriesState(s, { code: s.code, aliases: s.aliases, aggregation: null })).toBe("SEM AGREGAÇÃO");
    // catálogo antigo no banco: "inflação" só na mensal
    expect(seriesState(s, { code: s.code, aliases: ["ipca", "inflação", "custo de vida"], aggregation: "none" })).toBe("DESATUALIZADA");
    expect(seriesState(s, { code: s.code, aliases: s.aliases, aggregation: "accum_12m" })).toBe("DESATUALIZADA");
    expect(seriesState(s, { code: s.code, aliases: [...s.aliases].reverse(), aggregation: "none" })).toBe("carregada");
    expect(seriesState(CATALOG.find((x) => x.pending)!, undefined)).toBe("PENDENTE");
  });
});

// Portas falsas a partir dos fixtures (sem rede).
const sidraFrom = (file: string): Fetchers["sidra"] => async () => ({ url: "fixture", obs: parseSidra(fx(file)) });
const sgsFrom = (file: string): Fetchers["sgs"] => async () => parseSgs(fx(file));
const failing = (msg: string) => async (): Promise<never> => {
  throw new Error(msg);
};
const SINCE = "2003-01-01";
const UNTIL = "2026-10-21";

describe("[RF15] desocupação móvel: SIDRA 6381 (principal) e SGS 24369 (reserva)", () => {
  const movel = serie("desocupacao_pnadc_movel");
  const SIDRA_6381 = "sidra_6381_movel_2025-12_2026-06.json";
  const SGS_24369 = "sgs_24369_desocupacao_2025-12_2026-06.json";

  it("catálogo: principal SIDRA 6381 v4099 (a tabela tem outras variáveis), reserva SGS 24369, evidência na tabela do IBGE", () => {
    expect(movel.fetch).toEqual({ kind: "sidra", table: "6381", variable: "4099" });
    expect(movel.fallback).toEqual({ kind: "sgs", code: 24369 });
    expect(movel.source_url).toBe("https://sidra.ibge.gov.br/tabela/6381");
    expect(describeFetch(movel.fetch)).toBe("SIDRA t6381 v4099");
  });

  it("período AAAAMM da 6381 = trimestre móvel terminado no mês (valores reais divulgados pelo IBGE)", async () => {
    const v = await loadFrom(movel, movel.fetch, SINCE, UNTIL, { sidra: sidraFrom(SIDRA_6381) });
    expect(v).toHaveLength(7);
    // "no trimestre encerrado em março, desocupação sobe para 6,1%"
    expect(v.find((x) => x.period_end === "2026-03-31")).toMatchObject({ period_start: "2026-01-01", value: 6.1 });
    // "taxa de desocupação é de 5,6% ... no trimestre encerrado em maio"
    expect(v.find((x) => x.period_end === "2026-05-31")).toMatchObject({ period_start: "2026-03-01", value: 5.6 });
    // out-nov-dez 2025 atravessa o ano
    expect(v[0]).toMatchObject({ period_start: "2025-10-01", period_end: "2025-12-31", value: 5.1 });
  });

  it("principal e reserva dão as MESMAS linhas (mesma chave do upsert, mesma leitura na L2)", async () => {
    const a = await loadFrom(movel, movel.fetch, SINCE, UNTIL, { sidra: sidraFrom(SIDRA_6381) });
    const b = await loadFrom(movel, movel.fallback!, SINCE, UNTIL, { sgs: sgsFrom(SGS_24369) });
    expect(b).toEqual(a);
    const logs: string[] = [];
    expect(compareSources({ log: (m) => logs.push(String(m)), warn: (m) => logs.push(`W ${m}`) }, "teste", a, b)).toBe(0);
    expect(logs.at(-1)).toMatch(/7 períodos comparados, 0 divergências/);
  });

  it("SIDRA fora (HTML, desafio, timeout): usa a reserva e avisa", async () => {
    const warns: string[] = [];
    const r = await loadSeries(movel, SINCE, UNTIL, {
      warn: (m) => warns.push(m),
      fetchers: { sidra: failing("SIDRA indisponível nas duas portas"), sgs: sgsFrom(SGS_24369) },
    });
    expect(r.source).toBe("reserva");
    expect(r.values).toHaveLength(7);
    expect(warns).toEqual([
      "desocupacao_pnadc_movel: SIDRA t6381 v4099 falhou (SIDRA indisponível nas duas portas); usando a reserva SGS 24369",
    ]);
  });

  it("SIDRA sem nenhum valor no período também passa para a reserva; principal ok não chama a reserva", async () => {
    const empty: Fetchers["sidra"] = async () => ({ url: "x", obs: [] });
    const r = await loadSeries(movel, SINCE, UNTIL, { fetchers: { sidra: empty, sgs: sgsFrom(SGS_24369) } });
    expect(r.source).toBe("reserva");
    let sgsCalls = 0;
    const ok = await loadSeries(movel, SINCE, UNTIL, {
      fetchers: { sidra: sidraFrom(SIDRA_6381), sgs: async () => (sgsCalls++, []) },
    });
    expect(ok.source).toBe("principal");
    expect(sgsCalls).toBe(0);
  });

  it("as duas fora: erro com as duas causas (a carga marca falha; nada é gravado)", async () => {
    await expect(
      loadSeriesValues(movel, SINCE, UNTIL, { fetchers: { sidra: failing("HTTP 403"), sgs: failing("resposta não é JSON (3 tentativas): <?xml") } }),
    ).rejects.toThrow("SIDRA t6381 v4099: HTTP 403 | reserva SGS 24369: resposta não é JSON (3 tentativas): <?xml");
  });

  it("série sem reserva: o erro da principal passa direto", async () => {
    await expect(loadSeriesValues(serie("ipca_12m"), SINCE, UNTIL, { fetchers: { sgs: failing("timeout") } })).rejects.toThrow(/^timeout$/);
  });

  it("--check acusa reserva com rótulo deslocado (trimestre móvel datado pelo 1º mês)", async () => {
    const a = await loadFrom(movel, movel.fetch, SINCE, UNTIL, { sidra: sidraFrom(SIDRA_6381) });
    const shifted: IndicatorValue[] = a.map((v, i) => ({ ...v, value: a[i + 2]?.value ?? v.value }));
    const warns: string[] = [];
    expect(compareSources({ log: () => {}, warn: (m) => warns.push(String(m)) }, "6381 × 24369", a, shifted)).toBeGreaterThan(0);
    expect(warns[0]).toMatch(/^6381 × 24369 2025-10-01\.\.2025-12-31: 5\.1 × /);
  });
});

describe("[RF15] SGS devolvendo HTML no lugar do JSON: tenta de novo, pouco", () => {
  afterEach(() => vi.unstubAllGlobals());
  const XHTML = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">';
  const stub = (bodies: string[]) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(bodies[Math.min(calls.length - 1, bodies.length - 1)]!, { status: 200 });
    });
    return calls;
  };

  it("HTML e depois JSON: devolve o JSON na 2ª tentativa", async () => {
    const calls = stub([XHTML, '[{"data":"01/03/2026","valor":"6.1"}]']);
    const json = await fetchJson("https://sgs-html-1.test/dados", { nonJsonRetries: SGS_NON_JSON_RETRIES, nonJsonDelayMs: 1 });
    expect(parseSgs(json)).toEqual([{ date: "2026-03-01", value: 6.1 }]);
    expect(calls).toHaveLength(2);
  });

  it("HTML sempre: desiste depois de 1 + 2 tentativas, com a página no erro", async () => {
    const calls = stub([XHTML]);
    await expect(fetchJson("https://sgs-html-2.test/dados", { nonJsonRetries: SGS_NON_JSON_RETRIES, nonJsonDelayMs: 1 })).rejects.toThrow(
      /resposta não é JSON \(3 tentativas\): <\?xml/,
    );
    expect(calls).toHaveLength(3);
  });

  it("sem nonJsonRetries (SIDRA, demais APIs): uma tentativa só, como antes", async () => {
    const calls = stub([XHTML]);
    await expect(fetchJson("https://sgs-html-3.test/dados")).rejects.toThrow(/^HTTP 200 .*resposta não é JSON: <\?xml/);
    expect(calls).toHaveLength(1);
    expect(SGS_NON_JSON_RETRIES).toBe(2);
  });
});

describe("[RF15] PIB — taxa de variação real no ano (SGS 7326)", () => {
  const anual = serie("pib_variacao_anual");
  const load = () => loadFrom(anual, anual.fetch, SINCE, UNTIL, { sgs: sgsFrom("sgs_7326_pib_anual_2003-2025.json") });

  it("ativa, série 7326 do SGS, taxa em %", () => {
    expect(anual.pending).toBeUndefined();
    expect(anual.fetch).toEqual({ kind: "sgs", code: 7326 });
    expect(anual.source_url).toBe("https://api.bcb.gov.br/dados/serie/bcdata.sgs.7326/dados?formato=json");
    expect(anual.unit).toBe("%");
    expect(activeSeries().map((s) => s.code)).toContain("pib_variacao_anual");
  });

  it("valores reais batem com as referências (2010 = 7,5; 2020 ≈ −3,3; 2023 ≈ 3,2) e cada ponto é o ano civil", async () => {
    const v = await load();
    const year = (y: number) => v.find((x) => x.period_start === `${y}-01-01`)!;
    expect(year(2010)).toMatchObject({ period_end: "2010-12-31" });
    expect(year(2010).value).toBeCloseTo(7.5, 1);
    expect(year(2020).value).toBeCloseTo(-3.3, 1);
    expect(year(2023).value).toBeCloseTo(3.2, 1);
    expect(v).toHaveLength(23);
  });

  it("média no período: 2003–2010 ≈ 4,1% ao ano (média das taxas anuais, o que mean_or_last calcula)", async () => {
    const v = (await load()).filter((x) => x.period_start >= "2003-01-01" && x.period_end <= "2010-12-31");
    expect(v).toHaveLength(8);
    const mean = v.reduce((s, x) => s + x.value, 0) / v.length;
    expect(mean).toBeCloseTo(4.1, 1);
    // a geométrica (crescimento composto) fica a 0,03 p.p. — bem dentro da tolerância de 0,3 p.p.
    const geo = (v.reduce((p, x) => p * (1 + x.value / 100), 1) ** (1 / v.length) - 1) * 100;
    expect(Math.abs(mean - geo)).toBeLessThan(0.05);
  });
});

describe("[RF15] série manual: carga tributária bruta (Tesouro Nacional)", () => {
  const carga = serie("carga_tributaria_pib");
  type RawFile = Record<string, unknown> & { values: Record<string, unknown>[] };
  const raw = () => structuredClone(MANUAL_SERIES_RAW.carga_tributaria) as RawFile;

  it("catálogo: ativa, manual, % do PIB, anual, fonte do Tesouro (nível 1) e aliases do extrator", () => {
    expect(carga.pending).toBeUndefined();
    expect(carga.fetch).toEqual({ kind: "manual", file: "carga_tributaria" });
    expect(carga.unit).toBe("% do PIB");
    expect(carga.periodicity).toBe("annual");
    expect(lookupSource(carga.source_url)).toMatchObject({ tier: 1, kind: "oficial" });
    expect(carga.aliases).toEqual(expect.arrayContaining(["carga tributária", "impostos em relação ao pib", "peso dos impostos"]));
  });

  it("carrega só os valores conferidos (2024 e 2025 da edição de 10/04/2026), cada um com URL oficial", async () => {
    const v = await loadSeriesValues(carga, SINCE, UNTIL);
    expect(v).toEqual([
      { series_code: "carga_tributaria_pib", period_start: "2024-01-01", period_end: "2024-12-31", value: 32.22, released_at: "2026-04-10" },
      { series_code: "carga_tributaria_pib", period_start: "2025-01-01", period_end: "2025-12-31", value: 32.4, released_at: "2026-04-10" },
    ]);
    for (const x of raw().values) {
      expect(lookupSource(String(x.url))?.tier).toBe(1);
      expect(String(x.verified_by).length).toBeGreaterThan(20);
    }
  });

  it("recusa o arquivo se um valor fugir das regras (nunca carrega metade)", () => {
    const bad = (mut: (r: RawFile) => void) => {
      const r = raw();
      mut(r);
      return () => parseManualSeries(r, carga);
    };
    expect(bad((r) => (r.values[0]!.url = "https://www.infomoney.com.br/economia/x"))).toThrow(/não é fonte de nível 1 ou 2/);
    expect(bad((r) => (r.values[0]!.url = "https://valor.globo.com/brasil/x"))).toThrow(/falta confirmed_by/);
    expect(bad((r) => r.values.push({ ...r.values[0]! }))).toThrow(/2025 repetido/);
    expect(bad((r) => (r.values[0]!.period = "2025-T1"))).toThrow(/inválido para série annual/);
    expect(bad((r) => (r.unit = "%"))).toThrow(/unidade/);
    expect(bad((r) => (r.series = "outra"))).toThrow(/esperado carga_tributaria_pib/);
    expect(bad((r) => delete r.values[0]!.verified_by)).toThrow(/inválida/);
  });

  it("nível 2 só vale com segunda fonte de nível 2 de outro veículo", () => {
    expect(sourceProblem({ url: "https://valor.globo.com/a", confirmed_by: "https://www1.folha.uol.com.br/b" })).toBeNull();
    expect(sourceProblem({ url: "https://valor.globo.com/a", confirmed_by: "https://valor.globo.com/b" })).toMatch(/mesmo veículo/);
    expect(sourceProblem({ url: "https://valor.globo.com/a", confirmed_by: "https://www.cnnbrasil.com.br/b" })).toMatch(/não é fonte de nível 1 ou 2/);
    expect(sourceProblem({ url: "https://www.tesourotransparente.gov.br/publicacoes/x" })).toBeNull();
  });

  it("períodos por periodicidade e arquivo não embutido com instrução", async () => {
    expect(manualPeriod("2025", "annual")).toEqual(yearPeriod(2025));
    expect(manualPeriod("2026-03", "monthly")).toEqual(monthPeriod(2026, 3));
    expect(manualPeriod("2026-03", "moving_quarter")).toEqual(movingQuarterPeriod(2026, 3));
    expect(manualPeriod("2026-T2", "quarterly")).toEqual(quarterPeriod(2026, 2));
    expect(() => manualPeriod("2026", "monthly")).toThrow();
    expect(() => manualSeriesRaw("nao_existe")).toThrow(/gen:sources/);
    const s: CatalogSeries = { ...carga, fetch: { kind: "manual", file: "nao_existe" } };
    await expect(loadSeriesValues(s, SINCE, UNTIL)).rejects.toThrow(/sources\/manual\/nao_existe\.yaml/);
  });
});
