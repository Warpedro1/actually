// Fatos de referência (camada L2): mandatos e eleições com a conta feita em código.
import type { RefElection, RefMandate } from "@actually/db";
import { describe, expect, it } from "vitest";
import type { ExtractionOutput } from "../src/extract";
import { toReference } from "../src/extract";
import { createPipeline } from "../src/index";
import { compareValue, electionResult, partyFor, samePerson, timeInPower } from "../src/retrieve/reference";
import type { ReferenceRef } from "../src/types";
import type { VerifyOutput } from "../src/verify";
import { MemoryStore, fakeAnthropic, makeDeps, type FakeReply } from "./helpers";

const SRC = { fonte_nome: "Biblioteca da Presidência da República", fonte_url: "https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes", trecho: "t", notas: null };
const m = (id: string, pessoa: string, partido: string, inicio: string, fim: string | null, papel: RefMandate["papel"] = "titular"): RefMandate =>
  ({ id, pessoa, partido, inicio, fim, papel, ...SRC });

export const MANDATES: RefMandate[] = [
  m("fhc-1995", "Fernando Henrique Cardoso", "PSDB", "1995-01-01", "2003-01-01"),
  m("lula-2003", "Luiz Inácio Lula da Silva", "PT", "2003-01-01", "2011-01-01"),
  m("dilma-2011", "Dilma Rousseff", "PT", "2011-01-01", "2016-05-12"),
  m("temer-interino", "Michel Temer", "MDB", "2016-05-12", "2016-08-31", "interino"),
  m("temer-2016", "Michel Temer", "MDB", "2016-08-31", "2019-01-01"),
  m("bolsonaro-psl", "Jair Messias Bolsonaro", "PSL", "2019-01-01", "2019-11-19"),
  m("bolsonaro-sem", "Jair Messias Bolsonaro", "sem partido", "2019-11-19", "2021-11-30"),
  m("bolsonaro-pl", "Jair Messias Bolsonaro", "PL", "2021-11-30", "2023-01-01"),
  m("lula-2023", "Luiz Inácio Lula da Silva", "PT", "2023-01-01", null),
];

const TSE = { fonte_nome: "TSE", fonte_url: "https://resultados.tse.jus.br/oficial/app/index.html", trecho: "t" };
export const ELECTIONS: RefElection[] = [
  { id: "2022-2-lula", ano: 2022, turno: 2, candidato: "Luiz Inácio Lula da Silva", partido: "PT", votos: 60_345_999, pct_validos: 50.9, eleito: true, ...TSE },
  { id: "2022-2-bolsonaro", ano: 2022, turno: 2, candidato: "Jair Messias Bolsonaro", partido: "PL", votos: 58_206_354, pct_validos: 49.1, eleito: false, ...TSE },
];

const AS_OF = "2026-10-23";
const ref = (over: Partial<ReferenceRef>): ReferenceRef => ({
  type: "tempo_no_poder", subject: "PT", window_years: null, year: null, round: null,
  claimed_value: 0, unit: "anos", qualifier: "exato", ...over,
});

describe("[RF03] fatos de referência — conta em código", () => {
  it("nome dito casa com o nome completo; apelido conhecido também; partido pela sigla", () => {
    expect(samePerson("Lula", "Luiz Inácio Lula da Silva")).toBe(true);
    expect(samePerson("Bolsonaro", "Jair Messias Bolsonaro")).toBe(true);
    expect(samePerson("Flávio Bolsonaro", "Jair Messias Bolsonaro")).toBe(false);
    expect(samePerson("FHC", "Fernando Henrique Cardoso")).toBe(true);
    expect(partyFor("Partido dos Trabalhadores")).toBe("PT");
    expect(partyFor("PMDB")).toBe("MDB");
  });

  it("\"o PT governou 20 dos últimos 24 anos\": ~17,2 anos ⇒ impreciso, com o número calculado na evidência", () => {
    const r = timeInPower(ref({ window_years: 24, claimed_value: 20 }), MANDATES, AS_OF);
    expect(r.comparison.actual).toBeCloseTo(17.2, 1);
    expect(r.comparison).toMatchObject({ status: "minor_mismatch", expected_verdict: "impreciso" });
    expect(r.comparison.evidence_text).toContain("nos últimos 24 anos");
    expect(r.comparison.evidence_text).toContain("17,2 anos, cerca de 17 anos");
    expect(r.comparison.evidence_text).toContain("Dilma Rousseff (PT), de 01/01/2011 a 12/05/2016");
    expect(r.comparison.evidence_text).not.toContain("Temer");
  });

  it("\"Lula governa há 12 anos\" (tempo total ~11,8) ⇒ confere; \"30 anos\" ⇒ contradito", () => {
    expect(timeInPower(ref({ subject: "Lula", claimed_value: 12 }), MANDATES, AS_OF).comparison.status).toBe("match");
    expect(timeInPower(ref({ subject: "Lula", claimed_value: 30 }), MANDATES, AS_OF).comparison)
      .toMatchObject({ status: "mismatch", expected_verdict: "contradito" });
  });

  it("sem janela, valor abaixo do total pode ser parte dele (\"Lula governou 8 anos\", \"os 13 anos do PT\") ⇒ silêncio", () => {
    expect(timeInPower(ref({ subject: "Lula", claimed_value: 8 }), MANDATES, AS_OF).comparison)
      .toMatchObject({ status: "no_data", reason: "parte_do_total" });
    expect(timeInPower(ref({ subject: "PT", claimed_value: 13 }), MANDATES, AS_OF).comparison.status).toBe("no_data");
    // com janela explícita, o valor abaixo é acusável
    expect(timeInPower(ref({ subject: "PT", window_years: 24, claimed_value: 10 }), MANDATES, AS_OF).comparison.status).toBe("mismatch");
  });

  it("interino conta para quem exerceu: o afastamento de Dilma (12/05 a 31/08/2016) não entra no tempo do PT", () => {
    // janela de 0,4 ano até 31/08/2016 = de 07/04/2016 a 31/08/2016 (146 dias)
    const pt = timeInPower(ref({ window_years: 0.4, claimed_value: 0.4 }), MANDATES, "2016-08-31").comparison;
    const mdb = timeInPower(ref({ subject: "MDB", window_years: 0.4, claimed_value: 0.3 }), MANDATES, "2016-08-31").comparison;
    expect(pt.actual).toBe(0.1); // 35 dias de Dilma até o afastamento
    expect(mdb.actual).toBe(0.3); // 111 dias de Temer interino
    expect(mdb.evidence_text).toContain("Michel Temer (MDB, interino), de 12/05/2016 a 31/08/2016");
  });

  it("pessoa ou partido sem mandato ⇒ sem dado (silêncio), nunca contradito", () => {
    expect(timeInPower(ref({ subject: "Flávio Bolsonaro", claimed_value: 4 }), MANDATES, AS_OF).comparison.status).toBe("no_data");
    expect(timeInPower(ref({ subject: "PSOL", claimed_value: 4 }), MANDATES, AS_OF).comparison.status).toBe("no_data");
  });

  it("qualificadores: \"mais de\" com valor maior confere; \"quase\" logo abaixo confere", () => {
    const tol = { match: 1, minor: 3 };
    expect(compareValue(50, 58, "mais_de", tol)).toBe("match");
    expect(compareValue(60, 58, "mais_de", tol)).toBe("minor_mismatch");
    expect(compareValue(60, 58, "quase", tol)).toBe("match");
    expect(compareValue(60, 54, "exato", tol)).toBe("mismatch");
  });

  it("eleição: votos e percentual de válidos com tolerância; candidato ambíguo ⇒ sem dado", () => {
    const e = (over: Partial<ReferenceRef>) =>
      electionResult(ref({ type: "eleicao", year: 2022, round: 2, unit: "votos", ...over }), ELECTIONS).comparison;
    expect(e({ subject: "Bolsonaro", claimed_value: 58_000_000 }).status).toBe("match");
    expect(e({ subject: "Lula", claimed_value: 70_000_000 })).toMatchObject({ status: "mismatch", expected_verdict: "contradito" });
    expect(e({ subject: "Lula", claimed_value: 51, unit: "%" }).status).toBe("match");
    expect(e({ subject: "Lula", claimed_value: 51, unit: "%" }).evidence_text).toContain("60.345.999 votos, 50,90%");
    // escala trocada: "58" dito como 58 milhões ⇒ silêncio, não contradito
    expect(e({ subject: "Bolsonaro", claimed_value: 58 })).toMatchObject({ status: "no_data", reason: "escala_incompativel" });
    const twoSilvas = [...ELECTIONS, { ...ELECTIONS[0]!, id: "x", candidato: "Marina Silva" }];
    expect(electionResult(ref({ type: "eleicao", subject: "Silva", year: 2022, round: 2, unit: "votos", claimed_value: 1 }), twoSilvas).comparison.reason).toBe("candidato_ambiguo");
  });
});

describe("[RF02] extração do fato de referência", () => {
  type Raw = ExtractionOutput["claims"][number]["reference"];
  const raw = (over: Partial<NonNullable<Raw>>): Raw => ({
    type: "tempo_no_poder", subject: "PT", window_years: 24, year: null, round: null, claimed_value: 20, unit: "anos", qualifier: "exato", ...over,
  });
  it("só passa inteiro e coerente", () => {
    expect(toReference(raw({}))).toMatchObject({ type: "tempo_no_poder", subject: "PT", window_years: 24, claimed_value: 20 });
    expect(toReference(raw({ unit: "votos" }))).toBeNull();
    expect(toReference(raw({ type: "eleicao", unit: "votos", year: 2022, round: 3 }))).toBeNull();
    expect(toReference(raw({ type: "eleicao", unit: "votos", year: 2022, round: 2 }))).toMatchObject({ year: 2022, round: 2, window_years: null });
    expect(toReference(raw({ qualifier: "uns" }))!.qualifier).toBe("exato");
    expect(toReference(null)).toBeNull();
  });
});

describe("[RF03] [RF05] fato de referência no pipeline", () => {
  const SEG = "Nós governamos o Brasil em 20 dos últimos 24 anos e o país cresceu.";
  const extractPT = (): FakeReply<ExtractionOutput> => ({
    output: {
      claims: [{
        text_original: "governamos o Brasil em 20 dos últimos 24 anos",
        text_normalized: "O PT governou o Brasil em 20 dos últimos 24 anos.",
        topic: "outro", tipo: "fato", measurable: null, numbers: [], indicator: null, time_reference: null,
        reference: { type: "tempo_no_poder", subject: "PT", window_years: 24, year: null, round: null, claimed_value: 20, unit: "anos", qualifier: "exato" },
      }],
    },
  });

  it("gera amarelo com a evidência calculada (verificada) e a fonte oficial", async () => {
    const store = new MemoryStore({ mandates: MANDATES }, { require_yellow_approval: false });
    let verifyMsg = "";
    const verify = (u: string): FakeReply<VerifyOutput> => {
      verifyMsg = u;
      return {
        output: {
          rationale: "r", verdict: "impreciso", confidence: 0.9,
          correction: "Pelas datas oficiais dos mandatos, o PT ficou 17,2 anos na Presidência nos últimos 24 anos.",
          summary: "O PT ficou cerca de 17 anos na Presidência nos últimos 24.",
          citations: [{ evidence_index: 1, quote: "17,2 anos" }],
        },
      };
    };
    const deps = makeDeps({ store, anthropic: fakeAnthropic({ extract: extractPT, verify }), now: () => Date.parse("2026-10-23T22:00:00Z") });
    const res = await createPipeline(deps).runPipeline(store.addSegment(SEG).id);
    expect(verifyMsg).toContain("17,2 anos");
    expect(res.alerts, JSON.stringify(store.verifications[0]?.score_components)).toBe(1);
    expect(store.alerts[0]).toMatchObject({ verdict: "impreciso", status: "published" });
    const ev = store.evidence.find((e) => e.verification_id === store.alerts[0]!.verification_id)!;
    expect(ev).toMatchObject({ quote_verified: true, source_tier: 1, url: SRC.fonte_url });
    expect(ev.quote).toContain("17,2 anos");
  });

  it("sem os dados de referência carregados ⇒ silêncio (nunca quebra)", async () => {
    const store = new MemoryStore({}, { require_yellow_approval: false });
    const deps = makeDeps({
      store, now: () => Date.parse("2026-10-23T22:00:00Z"),
      anthropic: fakeAnthropic({ extract: extractPT, verify: () => ({ output: { rationale: "r", verdict: "inconclusivo", confidence: 0.1, correction: "", summary: "", citations: [] } }) }),
    });
    const res = await createPipeline(deps).runPipeline(store.addSegment(SEG).id);
    expect(res.alerts).toBe(0);
    // silêncio de verdade: nada de erro nem de camada quebrada
    expect(deps.logs.filter((l) => l.level === "error" || l.event === "layer_failed")).toEqual([]);
  });

  it("referência lançando exceção (tabela fora) ⇒ silêncio, nunca alerta", async () => {
    const store = new MemoryStore({ mandates: MANDATES }, { require_yellow_approval: false });
    store.failing.add("refMandates");
    const deps = makeDeps({
      store, now: () => Date.parse("2026-10-23T22:00:00Z"),
      anthropic: fakeAnthropic({ extract: extractPT, verify: () => ({ output: { rationale: "r", verdict: "inconclusivo", confidence: 0.1, correction: "", summary: "", citations: [] } }) }),
    });
    const res = await createPipeline(deps).runPipeline(store.addSegment(SEG).id);
    expect(res.alerts).toBe(0);
    expect(deps.logs.some((l) => l.event === "layer_failed" && l.fields?.layer === "L2")).toBe(true);
  });
});
