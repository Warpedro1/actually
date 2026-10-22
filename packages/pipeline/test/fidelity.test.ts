// Pacote de fidelidade (ensaio 2, 21/10): a afirmação normalizada não pode dizer mais do que a
// fala, e as travas são determinísticas — só descartam (na dúvida, silêncio).
import type { DebateSettings } from "@actually/db";
import { describe, expect, it } from "vitest";
import {
  addsRate, electionUnderspecified, inventedNames, isHedged, isOpenQuestion, postprocessExtraction, unlicensedYears,
  type ExtractionOutput,
} from "../src/extract";
import { createPipeline } from "../src/index";
import { extractNumbers } from "../src/normalize";
import { numbersSupported } from "../src/quoteCheck";
import { accentsLost } from "../src/retrieve/web";
import { scoreDecision, type ScoreInput } from "../src/score";
import type { EvidenceRecord } from "../src/types";
import { VERIFY_SYSTEM } from "../src/verify";
import { fakeAnthropic, makeDeps, MemoryStore, type FakeReply } from "./helpers";

type ClaimOut = ExtractionOutput["claims"][number];
const claim = (original: string, normalized: string, over: Partial<ClaimOut> = {}): ClaimOut => ({
  text_original: original, text_normalized: normalized, topic: "economia", tipo: "fato", measurable: null, numbers: [],
  indicator: null, reference: null, time_reference: null, ...over,
});
const TODAY = "2026-10-21";
function run(c: ClaimOut, segment = c.text_original, context = "") {
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  const out = postprocessExtraction({ claims: [c] }, segment, (_l, msg, fields) => logs.push({ msg, fields: fields ?? {} }), {
    context, today: TODAY,
  });
  const dropped = logs.find((l) => l.msg === "extract_dropped")?.fields.reason ?? null;
  return { out, dropped };
}

describe("[RF02] fidelidade: ano que a fala não diz derruba a afirmação", () => {
  it("\"cresceu 7 e meio\" virando \"de 2003 a 2010\" (ensaio 2) cai; com o 2010 dito no contexto, fica", () => {
    const c = claim("e a economia cresceu 7 e meio por 100", "A economia brasileira cresceu 7,5% ao ano de 2003 a 2010.");
    expect(run(c).dropped).toBe("normalizacao_acrescenta_ano");
    const ok = claim("e a economia cresceu 7 e meio por 100", "A economia brasileira cresceu 7,5% em 2010.");
    expect(run(ok, ok.text_original, "[S2] o último ano do meu governo foi 2010").out).toHaveLength(1);
  });

  it("período no indicador ou no time_reference também conta", () => {
    const c = claim("o PIB cresceu muito", "O PIB cresceu muito no governo Lula.", {
      indicator: { query: "PIB", period: "2003..2010", claimed_value: null, unit: "%", kind: "level" },
    });
    expect(run(c).dropped).toBe("normalizacao_acrescenta_ano");
    expect(run(claim("o desemprego caiu", "O desemprego caiu.", { time_reference: "2023" })).dropped).toBe("normalizacao_acrescenta_ano");
  });

  it("período nomeado na fala (\"no governo do seu pai\", \"quando eu cheguei\", \"pandemia\") autoriza os anos dele", () => {
    const ind = (period: string) => ({ query: "desmatamento", period, claimed_value: 60, unit: "%", kind: "change_pct" });
    expect(run(claim("no governo do seu pai o desmatamento aumentou 60%", "O desmatamento na Amazônia aumentou 60% de 2019 a 2022.", {
      indicator: ind("2019..2022"),
    })).out).toHaveLength(1);
    expect(run(claim("no meu governo o PIB cresceu", "O PIB cresceu no governo Lula (2003 a 2010).")).out).toHaveLength(1);
    expect(run(claim("quando eu cheguei devia 30 bilhões ao FMI", "Em 2003, o Brasil devia US$ 30 bilhões ao FMI.")).out).toHaveLength(1);
    expect(run(claim("na pandemia morreram 700 mil", "Na pandemia de covid-19, entre 2020 e 2022, morreram 700 mil pessoas.")).out).toHaveLength(1);
    // ensaio 2: "depois que eu deixei" + 2010 dito no trecho ⇒ período 2011..2026 vale
    const seg = "Em 2010 a economia cresceu 7,5%. Depois que eu deixei a presidente ele só voltou a crescer acima de 3 por 100.";
    const c = claim("Depois que eu deixei a presidente ele só voltou a crescer acima de 3 por 100.", "O PIB do Brasil só voltou a crescer acima de 3% depois que Lula voltou.", {
      tipo: "estatistica", indicator: { query: "PIB", period: "2011..2026", claimed_value: 3, unit: "%", kind: "level" },
    });
    expect(run(c, seg).out).toHaveLength(1);
    // folga de 1 ano em volta de ano dito só vale nos campos de período, não no texto
    expect(unlicensedYears(["em 2011"], "em 2010", TODAY)).toEqual([2011]);
    expect(unlicensedYears([], "em 2010", TODAY, { periodFields: ["2011"] })).toEqual([]);
  });

  it("período nomeado só vale dito na própria afirmação, não em outra frase do trecho ou do contexto (Band, seg 36)", () => {
    const seg = "Quando eu cheguei na presidência devia 30000000000 para o FMI. E a economia cresceu 7 e meio por 100.";
    const c = claim("E a economia cresceu 7 e meio por 100.", "A economia brasileira cresceu 7,5% durante o primeiro governo Lula (2003 a 2010).");
    expect(run(c, seg).dropped).toBe("normalizacao_acrescenta_ano");
    expect(run(c, c.text_original, "[S2] no meu governo foi assim").dropped).toBe("normalizacao_acrescenta_ano");
  });

  it("\"ao ano\"/\"em média\" que a fala não diz cai (ensaio 1: \"cresceu 7 e meio\" virou \"7,5% ao ano no governo Lula\")", () => {
    expect(run(claim("a economia cresceu 7 e meio por 100", "Durante o governo Lula, a economia brasileira cresceu 7,5% ao ano.")).dropped)
      .toBe("escopo_acrescentado");
    expect(run(claim("a economia cresceu 4% ao ano no meu governo", "A economia brasileira cresceu 4% ao ano durante o governo Lula.")).out)
      .toHaveLength(1);
    expect(addsRate("O salário médio é de R$ 3 mil.", "o salário médio é 3 mil")).toBe(false);
  });

  it("\"em 2026\" inventado (maioridade penal) cai; \"ano passado\"/\"hoje\" autorizam o ano da data e vizinhos", () => {
    expect(run(claim("começaram a debater a redução da maioridade penal", "Governo e oposição começaram a debater a redução da maioridade penal em 2026.")).dropped)
      .toBe("normalizacao_acrescenta_ano");
    expect(run(claim("ano passado o desemprego caiu", "O desemprego no Brasil caiu em 2025.")).out).toHaveLength(1);
    expect(run(claim("hoje a inflação está em 4%", "A inflação no Brasil está em 4% em 2026.")).out).toHaveLength(1);
  });

  it("ano de 2 dígitos dito (\"de 88\") e janela \"últimos N anos\" valem", () => {
    expect(run(claim("a constituição de 88 garantiu", "A Constituição de 1988 garantiu que a segurança pública é responsabilidade dos estados.")).out)
      .toHaveLength(1);
    expect(run(claim("o PT governou 20 dos últimos 24 anos", "O PT governou o Brasil por 20 dos últimos 24 anos, desde 2003.")).out)
      .toHaveLength(1);
    expect(unlicensedYears(["entre 1990 e 2003"], "nos últimos 24 anos", TODAY)).toEqual([1990]);
  });
});

describe("[RF02] fidelidade: pergunta, hipótese, eleição sem ano/turno e nome inventado", () => {
  it("pergunta sem número cai; com número fica", () => {
    expect(isOpenQuestion("Por que que ele está fugido lá na Espanha?")).toBe(true);
    expect(isOpenQuestion("Você sabia que o desemprego é 6%?")).toBe(false);
    expect(isOpenQuestion("Ele está fugido.")).toBe(false);
    expect(run(claim("Por que que ele está fugido lá na Espanha?", "O filho de Lula está fugido na Espanha.", { tipo: "acusacao" })).dropped)
      .toBe("pergunta");
  });

  it("insinuação (\"pode ser\", \"talvez\") sem número cai", () => {
    expect(isHedged("o dinheiro pode ser do aposentado")).toBe(true);
    expect(isHedged("a pena pode ser de até 40 anos")).toBe(false);
    // "1" do Deepgram como artigo não é número
    expect(isHedged("talvez ele tenha 1 conta lá fora")).toBe(true);
    expect(isHedged("pode ser 1 milhão de reais")).toBe(false);
    expect(isOpenQuestion("Vocês sabem qual foi a bancada que insistiu para fazer 1 emendinha?")).toBe(true);
    expect(isOpenQuestion("Quem cortou 1 por cento do orçamento?")).toBe(false);
    expect(run(claim("o dinheiro pode ser do aposentado", "O dinheiro de Lulinha vem de aposentados.")).dropped).toBe("hipotese");
  });

  it("eleição: ano e turno precisam ter sido ditos", () => {
    const ref = (year: number | null, round: number | null) => ({
      type: "eleicao", subject: "Lula", window_years: null, year, round, claimed_value: 56_000_000, unit: "votos", qualifier: "exato",
    });
    const solto = claim("eu tive 56 milhões de votos", "Lula teve 56 milhões de votos.", { reference: ref(null, null) });
    expect(run(solto).dropped).toBe("periodo_ambiguo");
    // ano presumido (2022) que a fala não diz cai já na trava de anos
    expect(run(claim("eu tive 56 milhões de votos", "Lula teve 56 milhões de votos em 2022.", { reference: ref(2022, 2) })).dropped)
      .toBe("normalizacao_acrescenta_ano");
    const dito = claim("no segundo turno de 2022 eu tive 60 milhões de votos", "Lula teve 60 milhões de votos no 2º turno de 2022.", {
      reference: ref(2022, 2),
    });
    expect(run(dito).out).toHaveLength(1);
    expect(electionUnderspecified({ ...ref(2022, 1), type: "eleicao" } as never, "em 2022, no 1º turno")).toBe(false);
  });

  it("nome próprio que a fala e o contexto não trazem (\"Roberto Careca\") cai; candidatos e siglas não", () => {
    expect(inventedNames("Roberto Careca fez parte do governo Lula.", "o careca foi do seu governo")).toEqual(["Roberto Careca"]);
    expect(inventedNames("O Careca do INSS fez parte do governo Lula.", "o careca do inss foi do seu governo")).toEqual([]);
    expect(inventedNames("Flávio Bolsonaro votou contra a PEC da Transição.", "ele votou contra a pec da transição")).toEqual([]);
    // "a pec" virando "PEC da Transição" é detalhe que a fala não diz
    expect(inventedNames("Flávio Bolsonaro votou contra a PEC da Transição.", "ele votou contra a pec")).toEqual(["PEC da Transição"]);
    expect(inventedNames("A Polícia Federal investiga Roberta Luchsinger.", "a PF investiga ela [contexto: Roberta Luchsinger]")).toEqual([]);
    // hífen confere parte a parte; vírgula e parêntese separam; expansão de sigla vale
    expect(inventedNames("A Advocacia-Geral da União recorreu.", "a advocacia-geral da união recorreu")).toEqual([]);
    expect(inventedNames("O Pé-de-Meia paga R$ 200.", "o pé-de-meia paga 200 reais")).toEqual([]);
    expect(inventedNames("Segundo o ministro da Fazenda, Fernando Haddad, a arrecadação subiu.", "o haddad disse que a arrecadação subiu")).toEqual([]);
    expect(inventedNames("O Sistema Único de Saúde (SUS) foi criado em 1988.", "o SUS foi criado em 88")).toEqual([]);
    expect(inventedNames("Segundo o deputado, Marcos Pereira votou contra.", "ele votou contra")).toEqual(["Marcos Pereira"]);
    expect(run(claim("o careca foi do seu governo", "Roberto Careca fez parte do governo Lula.", { tipo: "acusacao" })).dropped)
      .toBe("nome_inventado");
  });

  it("auditoria: guarda o tipo do modelo e a regra que promoveu a acusação", () => {
    const { out } = run(claim("o ex-governador foi preso", "O ex-governador foi preso."));
    expect(out[0]).toMatchObject({ kind: "acusacao", kind_model: "fato", kind_rule: "promovida_de_fato" });
    const { out: o2 } = run(claim("o desemprego caiu", "O desemprego caiu."));
    expect(o2[0]).toMatchObject({ kind: "fato", kind_model: "fato" });
    expect(o2[0]!.kind_rule).toBeUndefined();
  });
});

describe("[RF05] números: correção só com número da fonte; negado só se o falante disse", () => {
  it("\"g1\", \"Poder360\" e \"R7\" não são números; R$1.000, intervalos e datas continuam", () => {
    expect(extractNumbers("Segundo o g1 e o Poder360, e a R7")).toEqual([]);
    expect(extractNumbers("R$1.000")[0]).toMatchObject({ value: 1000 });
    expect(extractNumbers("de 2015-2023").map((n) => n.value)).toEqual([2015, 2023]);
    expect(numbersSupported("Segundo o g1, a pena vai a 40 anos.", ["pena de 20 a 40 anos"]).ok).toBe(true);
    // código colado em letra é número (tribunal, conferência); nunca recomeça no meio de outro
    expect(extractNumbers("Lula foi condenado pelo TRF4.").map((n) => n.value)).toEqual([4]);
    expect(numbersSupported("Lula foi condenado pelo TRF1 em 2018.", ["condenado pelo TRF4 em janeiro de 2018"]).ok).toBe(false);
    expect(extractNumbers("escala 4x1").map((n) => n.value)).toEqual([4, 1]);
    expect(extractNumbers("Segundo o G1 e o Brasil247")).toEqual([]);
    expect(extractNumbers("Lei nº14.601/2023").map((n) => n.value)).toEqual([14601, 2023]);
    expect(extractNumbers("taxa de desocupação7,8%")[0]).toMatchObject({ value: 7.8, unit: "%" });
  });

  it("ano negado na correção só vale se estiver na fala literal, não só na reformulação (ensaio 2: \"2003\")", () => {
    const correction = "A economia cresceu 7,5% em 2010, e não de 2003 a 2010.";
    const sources = ["Sim, a economia brasileira cresceu 7,5% no último ano do mandato de Lula, em 2010"];
    const literal = numbersSupported(correction, sources, { refuted: ["e a economia cresceu 7 e meio por 100"], refutedWithUnit: ["cresceu 7,5% de 2003 a 2010"] });
    expect(literal).toEqual({ ok: false, unsupported: ["2003"] });
    // com unidade a reformulação vale ("7 e meio por 100" → "7,5%")
    expect(numbersSupported("Foi 4,1%, não 7,5%.", ["média de 4,1%"], { refuted: ["cresceu 7 e meio por 100"], refutedWithUnit: ["cresceu 7,5%"] }).ok)
      .toBe(true);
    // número dito pelo falante continua valendo negado ("não 80")
    expect(numbersSupported("A pena máxima é de 60 anos, não 80.", ["até 60 anos de prisão"], { refuted: ["vão ficar até 80 anos presos"] }).ok)
      .toBe(true);
  });

  it("número que a mediação ou o adversário disse não vale negado na correção do candidato", async () => {
    const store = new MemoryStore({ series: [], values: [] });
    store.addSegment("Candidatos, o desemprego já chegou a 12 por cento neste país.", { speaker_label: "s1-4f9a12:S0" });
    const seg = store.addSegment("No meu governo o desemprego em 2023 foi de 9%.", { speaker_label: "s1-4f9a12:S1" });
    const anthropic = fakeAnthropic({
      extract: () => ({ output: { claims: [claim("No meu governo o desemprego em 2023 foi de 9%.", "A taxa de desemprego no Brasil em 2023 foi de 9%.", { tipo: "estatistica" })] } }),
      verify: () => ({
        output: {
          rationale: "r", verdict: "contradito", confidence: 0.95,
          correction: "Segundo o IBGE, a taxa de desocupação em 2023 foi de 7,8%, não 12%.",
          summary: "Taxa foi 7,8%", citations: [{ evidence_index: 1, quote: "a taxa de desocupação foi de 7,8% em 2023" }],
        },
      }),
    });
    const deps = makeDeps({
      store, anthropic,
      webSearch: async () => [{
        url: "https://agenciadenoticias.ibge.gov.br/x", title: "PNAD", content: "a taxa de desocupação foi de 7,8% em 2023",
        raw_content: "Segundo o IBGE, a taxa de desocupação foi de 7,8% em 2023, a menor da série.", published_date: null, score: 1,
      }],
    });
    await createPipeline(deps).runPipeline(seg.id);
    expect(store.verifications.at(-1)!.score_components).toMatchObject({ silence_reason: "numero_sem_fonte", unsupported_numbers: "12%" });
    expect(store.alerts).toHaveLength(0);
    // o mesmo 12% dito antes pelo PRÓPRIO candidato vale negado
    const store2 = new MemoryStore({ series: [], values: [] });
    store2.addSegment("Teve época em que o desemprego chegou a 12 por cento.", { speaker_label: "s1-4f9a12:S1" });
    const seg2 = store2.addSegment("No meu governo o desemprego em 2023 foi de 9%.", { speaker_label: "s1-4f9a12:S1" });
    await createPipeline({ ...deps, store: store2 }).runPipeline(seg2.id);
    expect(store2.verifications.at(-1)!.score_components).not.toMatchObject({ silence_reason: "numero_sem_fonte" });
  });
});

describe("[RF03] busca web: página com o texto corrompido não vira evidência", () => {
  it("texto longo sem nenhum acento é descartado; texto normal fica", () => {
    expect(accentsLost("Compete Unio estabelecer a Poltica Nacional de Segurana Pblica e Defesa Social ".repeat(8))).toBe(true);
    expect(accentsLost("Compete à União estabelecer a Política Nacional de Segurança Pública ".repeat(8))).toBe(false);
    expect(accentsLost("texto curto sem acento")).toBe(false);
  });
});

describe("[RF03] verificador: projeto não contradiz lei; nuance não é impreciso; julga a fala original", () => {
  it("regras 4, 13 e 14 no prompt", () => {
    expect(VERIFY_SYSTEM).toMatch(/Nuance que não muda a essência/);
    expect(VERIFY_SYSTEM).toMatch(/checagem de nível 1 da MESMA fala diz que o falante acerta/);
    expect(VERIFY_SYSTEM).toMatch(/13\. Projeto em tramitação .* não contradiz afirmação sobre lei aprovada ou sancionada/);
    expect(VERIFY_SYSTEM).toMatch(/14\. Julgue o que o falante disse \("Trecho original da fala"\)/);
  });
});

describe("[RF07] [RF08] faixa de revisão do vermelho", () => {
  const SETTINGS: Pick<DebateSettings, "t_red" | "t_yellow" | "web_penalty"> = { t_red: 0.85, t_yellow: 0.75, web_penalty: 0.05 };
  const ev = (o: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
    layer: "L3", evidence_type: "document", url: "https://www.aosfatos.org/x", source_name: "Aos Fatos", source_tier: 1,
    quote: "É falso que", quote_verified: true, published_at: null, quote_similarity: 1, ...o,
  });
  // conf 0,8 · tier 1 · uma camada (0,5) · citações 1 ⇒ 0,5·0,8 + 0,2 + 0,1 + 0,1 = 0,80
  const base = (o: Partial<ScoreInput> = {}): ScoreInput => ({
    verdict: "contradito", model_confidence: 0.8, evidence: [ev()], citations_total: 1, citations_verified: 1,
    comparison: null, forced_reason: null, correction: "O PIB cresceu 3,97% em 2011.", correction_numbers_ok: true,
    kind: "estatistica", settings: SETTINGS, ...o,
  });

  it("contradito a 0,80 (limiar 0,85) vai ao editor, nunca direto ao público", () => {
    const r = scoreDecision(base());
    expect(r).toMatchObject({ alert: "red", review: true, silence_reason: null });
    expect(r.components.review_band).toBe(true);
    expect(scoreDecision(base({ kind: "fato" }))).toMatchObject({ alert: "red", review: true });
  });

  it("fora da faixa: abaixo de 0,80, confiança < 0,7, amarelo, acusação ou opinião ficam em silêncio", () => {
    expect(scoreDecision(base({ model_confidence: 0.78 }))).toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold" });
    // conf 0,65 dá 0,725: fora da faixa e abaixo da confiança mínima
    expect(scoreDecision(base({ model_confidence: 0.65 }))).toMatchObject({ alert: null });
    // amarelo a 0,70 (limiar 0,75): não tem faixa de revisão
    expect(scoreDecision(base({ verdict: "impreciso", model_confidence: 0.6 }))).toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold" });
    expect(scoreDecision(base({ kind: "acusacao" }))).toMatchObject({ alert: null });
    expect(scoreDecision(base({ kind: "opiniao_mensuravel" }))).toMatchObject({ alert: null });
  });

  it("regras duras continuam antes da faixa: número sem fonte e conflito silenciam", () => {
    expect(scoreDecision(base({ correction_numbers_ok: false }))).toMatchObject({ alert: null, silence_reason: "numero_sem_fonte" });
    const l1 = ev({ layer: "L1", evidence_type: "factcheck", factcheck_verdict: "confirmado" });
    expect(scoreDecision(base({ evidence: [ev(), l1] }))).toMatchObject({ alert: null, silence_reason: "camadas_em_conflito" });
  });

  it("com web a faixa acompanha o limiar (0,90 → a partir de 0,85)", () => {
    const web = ev({ layer: "L4", evidence_type: "web", source_tier: 2, url: "https://g1.globo.com/x" });
    // conf 0,95 · tier 2 (0,85) · 0,5 · 1 ⇒ 0,475 + 0,17 + 0,1 + 0,1 = 0,845: abaixo de 0,85
    expect(scoreDecision(base({ evidence: [web], model_confidence: 0.95 }))).toMatchObject({ alert: null });
    // conf 1 ⇒ 0,87: na faixa [0,85, 0,90)
    expect(scoreDecision(base({ evidence: [web], model_confidence: 1 }))).toMatchObject({ alert: "red", review: true });
  });
});

describe("[RF09] [RF02] mediação não é checada (mapa de falantes confirmado)", () => {
  const extract = (): FakeReply<ExtractionOutput> => ({
    output: { claims: [claim("o desemprego em 2023 foi de 12%", "A taxa de desemprego no Brasil em 2023 foi de 12%.")] },
  });

  it("segmento de quem foi mapeado como Mediação não chega ao extrator", async () => {
    const store = new MemoryStore();
    store.speakerMap = [{ speaker_label: "SPEAKER_0", person: "Mediação" }, { speaker_label: "SPEAKER_1", person: "Lula" }];
    const anthropic = fakeAnthropic({ extract, verify: () => ({ error: new Error("não deveria verificar") }) });
    const deps = makeDeps({ store, anthropic });
    const pipeline = createPipeline(deps);
    const seg = store.addSegment("Candidatos, o desemprego em 2023 foi de 12%, segundo o instituto.", { speaker_label: "SPEAKER_0" });
    expect(await pipeline.runPipeline(seg.id)).toMatchObject({ claims: 0, alerts: 0 });
    expect(anthropic.calls).toHaveLength(0);
    expect(deps.logs.some((l) => l.event === "extract_dropped" && l.fields?.reason === "mediacao")).toBe(true);
  });

  it("sem mapa, ou com o mapa fora do ar, segue como antes", async () => {
    const store = new MemoryStore();
    store.failing.add("getSpeakerMap");
    const anthropic = fakeAnthropic({ extract: () => ({ output: { claims: [] } }), verify: () => ({ error: new Error("x") }) });
    const pipeline = createPipeline(makeDeps({ store, anthropic }));
    const seg = store.addSegment("O desemprego em 2023 foi de 12%.", { speaker_label: "SPEAKER_0" });
    await pipeline.runPipeline(seg.id);
    expect(anthropic.calls.length).toBeGreaterThan(0);
  });
});
