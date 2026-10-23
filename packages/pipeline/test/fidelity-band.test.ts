// Fidelidade da extração com as falas reais do ensaio completo (debate da Band, 18/10):
// sujeito trocado, promessa reescrita como fato, "há N anos" lido como janela e transcrição
// embaralhada. As travas só descartam (na dúvida, silêncio); a fala fiel continua passando.
import type { RefMandate } from "@actually/db";
import { describe, expect, it } from "vitest";
import {
  buildExtractMessage, EXTRACT_SYSTEM, ExtractionSchema, garbledNumber, isPromise, postprocessExtraction, referenceUnitMissing,
  sentenceOf, subjectSwap, windowAsTotal, type ExtractionOutput,
} from "../src/extract";
import { createPipeline } from "../src/index";
import { timeInPower } from "../src/retrieve/reference";
import type { ReferenceRef } from "../src/types";
import type { VerifyOutput } from "../src/verify";
import { fakeAnthropic, makeDeps, MemoryStore, type FakeReply } from "./helpers";

type ClaimOut = ExtractionOutput["claims"][number];
const claim = (original: string, normalized: string, over: Partial<ClaimOut> = {}): ClaimOut => ({
  text_original: original, text_normalized: normalized, topic: "outro", tipo: "fato", measurable: null, numbers: [],
  indicator: null, reference: null, time_reference: null, transcricao_duvidosa: false, ...over,
});
const FLAVIO = { speaker: "Flávio Bolsonaro", opponents: ["Lula"] };
const LULA = { speaker: "Lula", opponents: ["Flávio Bolsonaro"] };
function run(c: ClaimOut, segment = c.text_original, who: { speaker?: string | null; opponents?: string[] } = {}) {
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  const out = postprocessExtraction({ claims: [c] }, segment, (_l, msg, fields) => logs.push({ msg, fields: fields ?? {} }), {
    today: "2026-10-18", ...who,
  });
  const dropped = logs.find((l) => l.msg === "extract_dropped")?.fields.reason ?? null;
  return { out, dropped };
}
const SILENT: FakeReply<VerifyOutput> = { output: { rationale: "r", verdict: "inconclusivo", confidence: 0.1, correction: "", summary: "", citations: [] } };

describe("[RF02] sujeito trocado: com o mapa de falantes, a afirmação não troca quem fez o quê", () => {
  it("fala em 2ª/3ª pessoa que vira o PRÓPRIO falante cai (falas reais do ensaio)", () => {
    // t≈5270: Flávio fala de Lula ("ele foi para lá") e o extrator montou a acusação contra Flávio
    const seg5270 = "Agora, ele foi para lá. Sabe para quê? Pedi para o Trump implorar Trump. Não taxa que os, ele falando, os nossos criminosos como terroristas não, ele foi para lá para defender CV e PCC, pelo amor de Deus.";
    expect(run(claim("ele foi para lá para defender CV e PCC", "O senador Flávio Bolsonaro foi aos Estados Unidos para defender o Comando Vermelho e o PCC.", { tipo: "acusacao" }), seg5270, FLAVIO).dropped)
      .toBe("sujeito_trocado");
    // t≈2238: "Você está dando emprego..." dito por Flávio
    const orig2238 = "Você está dando emprego para 1 monte de cara que foi condenado em discussão no mensalão, no petro, está";
    expect(run(claim(orig2238, "Flávio Bolsonaro está dando emprego para várias pessoas que foram condenadas no caso do mensalão e no caso do petrolão.", { tipo: "acusacao" }), orig2238, FLAVIO).dropped)
      .toBe("sujeito_trocado");
    // claim 48c6604e: "votaram em você" (Flávio para Lula) virou "votaram em Flávio" — o falante como objeto
    const seg2069 = "Inclusive, você pode explicar por que que 73 por 100 dos presidiários votaram em você?";
    expect(run(claim("73 por 100 dos presidiários votaram em você?", "73% dos presidiários votaram no candidato Flávio Bolsonaro.", { tipo: "estatistica" }), seg2069, FLAVIO).dropped)
      .toBe("sujeito_trocado");
    // t≈3489: Lula fala de Flávio ("ele nunca foi...") e virou "O candidato Lula nunca foi..."
    const seg3489 = "Então veja, ele ele ele não impedia de nada a saúde pública. Aliás acho que ele nunca foi no Fusca, ele nunca foi no AGUPA.";
    expect(run(claim("ele nunca foi no Fusca, ele nunca foi no AGUPA", "O candidato Lula nunca foi ao Fusca nem ao AGUPA."), seg3489, LULA).dropped)
      .toBe("sujeito_trocado");
    // t=1724, 2120 e 2280 (Lula): "você pegou", "me conta se você... não deixou", "no governo deles"
    expect(run(claim("você pegou 134000000 mentiu para sociedade brasileira", "O locutor Lula pegou 134 milhões de reais e mentiu para a sociedade brasileira.", { tipo: "acusacao" }), undefined, LULA).dropped)
      .toBe("sujeito_trocado");
    const meConta = "Me conta se você recebeu voto do cara que matou 1 criança de 5 anos que você não deixou ele ser preso.";
    expect(run(claim(meConta, "O presidente Lula não deixou preso o homem que matou uma criança de 5 anos.", { tipo: "acusacao" }), meConta, LULA).dropped)
      .toBe("sujeito_trocado");
    const armas = "No governo deles, eles liberaram mais de 1000000 de armas, mais de 1000000 de armas, 1 parte dela foi para o crime organizado, e 1100000000 de vagas.";
    expect(run(claim(armas, "No governo Lula, o governo liberou mais de 1 milhão de armas, e parte delas foi para o crime organizado."), armas, LULA).dropped)
      .toBe("sujeito_trocado");
  });

  it("fala em 1ª pessoa que vira o ADVERSÁRIO como sujeito cai", () => {
    expect(subjectSwap("Lula votou contra a PEC da Transição.", "Eu votei contra a PEC da Transição.", FLAVIO.speaker, FLAVIO.opponents)).toBe("adversario");
    expect(run(claim("Nós criamos o MEI", "O governo de Flávio Bolsonaro criou o MEI."), undefined, LULA).dropped).toBe("sujeito_trocado");
  });

  it("contraexemplos: a fala fiel passa", () => {
    // "ele" é o adversário: certo
    expect(run(claim("Ele votou contra a PEC da segurança", "Flávio Bolsonaro votou contra a PEC da segurança."), undefined, LULA).out).toHaveLength(1);
    // o falante citado de passagem, com o adversário de sujeito, também
    expect(run(claim("Ele votou contra a PEC da segurança", "O senador Flávio Bolsonaro votou contra a PEC da segurança do governo Lula."), undefined, LULA).out)
      .toHaveLength(1);
    // 1ª pessoa com o próprio falante de sujeito
    expect(run(claim("já governo o país há 12 anos", "Lula governa o Brasil há 12 anos."), undefined, LULA).out).toHaveLength(1);
    expect(run(claim("Eu votei contra a PEC do Lula", "Flávio Bolsonaro votou contra a PEC do governo Lula."), undefined, FLAVIO).out).toHaveLength(1);
    // o adversário nomeado na fala não é troca ("eu acho que o Flávio votou contra")
    expect(subjectSwap("Flávio Bolsonaro votou contra a PEC.", "Eu acho que o Flávio votou contra a PEC.", LULA.speaker, LULA.opponents)).toBeNull();
    // outro Flávio (Dino) não é o falante
    expect(subjectSwap("Flávio Dino foi indicado ao STF por Lula.", "Você indicou o Flávio Dino para o Supremo.", FLAVIO.speaker, FLAVIO.opponents)).toBeNull();
    // "governo Bolsonaro" é o do pai, não o Flávio
    expect(subjectSwap("No governo Bolsonaro o desmatamento subiu.", "No governo do seu pai o desmatamento subiu.", LULA.speaker, LULA.opponents)).toBeNull();
    expect(subjectSwap("O governo Jair Bolsonaro liberou armas.", "ele liberou armas", FLAVIO.speaker, FLAVIO.opponents)).toBeNull();
    // sem mapa de falantes a trava não age
    expect(run(claim("ele nunca foi no Fusca", "O candidato Lula nunca foi ao Fusca.")).out).toHaveLength(1);
  });

  it("contraexemplos do próprio ensaio que as travas não podem derrubar", () => {
    // t≈1162 (Lula): "Lulinha é o meu filho... E ele tem 3 inquérito" — o falante só como parentesco
    const lulinha = "Lulinha é o meu filho. Ah. Meu filho. Ah, conhece esse? Acho que ele é inocente. Esse você conhece. E ele tem 3 inquérito, e ele vai apurar o teu cartão, ele não vai ser negado.";
    expect(run(claim("ele tem 3 inquérito", "Lulinha, filho do presidente Lula, responde a 3 inquéritos.", { tipo: "acusacao" }), lulinha, LULA).out).toHaveLength(1);
    // t≈1789 (Lula imita Flávio; alerta perdido nº 6): "comprei 1 casa... como é você comprou 1 casa"
    const casa = "Coloquei para sustentar meu irmão, coloquei em 1 conta para mim, comprei 1 casa de 10000000. Aí me explica como é você comprou 1 casa de 10000000 para salário de senador? Diferente do seu";
    expect(run(claim("comprei 1 casa de 10000000", "Flávio Bolsonaro comprou uma casa de R$ 10 milhões."), casa, LULA).out).toHaveLength(1);
    // t≈1800 (Lula): "Esse cidadão criou o mesmo salário que eu" — "esse cidadão" aponta o outro
    const salario = "Olha só, eu estou com há 12 anos, e tenho 1 apartamento de 190 metros quadrado de 1000000 e meio. Esse cidadão criou o mesmo salário que eu.";
    expect(run(claim("Esse cidadão criou o mesmo salário que eu.", "O senador Flávio Bolsonaro recebe o mesmo salário que o presidente Lula."), salario, LULA).out)
      .toHaveLength(1);
    // Flávio: promessa + fato sobre o adversário dito pelo nome ("o Lula até hoje não colocou")
    const cadastro = "Eu vou colocar para funcionar, esse cadastro nacional de pedófilos, o Lula até hoje não colocou.";
    expect(run(claim(cadastro, "O governo Lula até hoje não implementou o cadastro nacional de pedófilos."), cadastro, FLAVIO).out).toHaveLength(1);
  });

  it("no pipeline: o extrator recebe quem fala e o adversário, o contexto com nomes, e a inversão não chega ao verificador", async () => {
    const store = new MemoryStore();
    store.speakerMap = [
      { speaker_label: "s1:S2", person: "Mediação" }, { speaker_label: "s1:S4", person: "Flávio Bolsonaro" }, { speaker_label: "s1:S5", person: "Lula" },
    ];
    store.addSegment("Eu fui aos Estados Unidos conversar com o Trump sobre o tarifaço.", { speaker_label: "s1:S5" });
    const seg = store.addSegment("Agora, ele foi para lá. Sabe para quê? ele foi para lá para defender CV e PCC, pelo amor de Deus.", { speaker_label: "s1:S4" });
    let extractMsg = "";
    const inverted = claim("ele foi para lá para defender CV e PCC", "O senador Flávio Bolsonaro foi aos Estados Unidos para defender o Comando Vermelho e o PCC.", { tipo: "acusacao" });
    const anthropic = fakeAnthropic({ extract: (u) => ((extractMsg = u), { output: { claims: [inverted] } }), verify: () => SILENT });
    const deps = makeDeps({ store, anthropic });
    expect(await createPipeline(deps).runPipeline(seg.id)).toMatchObject({ claims: 0, alerts: 0 });
    expect(extractMsg).toContain('pessoa="Flávio Bolsonaro"');
    expect(extractMsg).toContain("Quem fala agora: Flávio Bolsonaro (adversário: Lula).");
    expect(extractMsg).toContain("[Lula] Eu fui aos Estados Unidos");
    expect(anthropic.calls.map((c) => c.model)).toHaveLength(1);
    expect(deps.logs.some((l) => l.event === "extract_dropped" && l.fields?.reason === "sujeito_trocado")).toBe(true);

    // a versão fiel ("Lula foi aos EUA...") segue para a verificação
    const faithful = claim("ele foi para lá para defender CV e PCC", "Lula foi aos Estados Unidos para defender o Comando Vermelho e o PCC.", { tipo: "acusacao" });
    const anthropic2 = fakeAnthropic({ extract: () => ({ output: { claims: [faithful] } }), verify: () => SILENT });
    const store2 = new MemoryStore();
    store2.speakerMap = store.speakerMap;
    const seg2 = store2.addSegment(seg.text, { speaker_label: "s1:S4" });
    expect(await createPipeline(makeDeps({ store: store2, anthropic: anthropic2, webSearch: async () => [{
      url: "https://www.aosfatos.org/x", title: "t", content: "Lula foi aos EUA", raw_content: "Lula foi aos EUA e falou com Trump.", published_date: null, score: 1,
    }] })).runPipeline(seg2.id)).toMatchObject({ claims: 1 });
    expect(anthropic2.calls).toHaveLength(2);
  });
});

describe("[RF02] promessa reescrita como fato, opinião ou previsão cai", () => {
  it("falas reais do ensaio", () => {
    // t≈3294: "eu quero levar para o SUS" virou opinião mensurável
    const sus = "Porque eu quero colocar padrão Einstein no SUS. Aquele mesmo atendimento com tecnologia, com médicos, com hora marcada, sem fila, que tem na rede privada, eu quero levar para o SUS.";
    expect(run(claim("Aquele mesmo atendimento com tecnologia, com médicos, com hora marcada, sem fila, que tem na rede privada, eu quero levar para o SUS.",
      "O atendimento do Hospital Albert Einstein, com tecnologia, médicos, hora marcada e sem fila, é o mesmo atendimento que existe na rede privada.",
      { tipo: "opiniao_mensuravel", measurable: "tempo de espera no SUS" }), sus, FLAVIO).dropped).toBe("promessa");
    // t≈4504: "comigo o presidente ... vai despencar" virou previsão (e ainda trocou para "governo
    // Lula"). Previsão saiu dos tipos checáveis, então cai já no tipo, antes da trava de promessa.
    const juros = "Para ajudar você que quer sair dessa situação difícil. E pode ter certeza de 1 forma muito rápida comigo o presidente a taxa de juros despencando, a sua dívida vai despencar junto.";
    expect(run(claim("a taxa de juros despencando, a sua dívida vai despencar junto", "Com o governo Lula, a taxa de juros vai despencar e as dívidas dos endividados vão cair junto.",
      { tipo: "previsao", measurable: "projeção da Selic (Focus)" }), juros, FLAVIO).dropped).toBe("previsao");
    // a mesma fala rotulada como estatística continua caindo como promessa
    expect(run(claim("a taxa de juros despencando, a sua dívida vai despencar junto", "Com o governo Lula, a taxa de juros vai despencar e as dívidas dos endividados vão cair junto.",
      { tipo: "estatistica" }), juros, FLAVIO).dropped).toBe("promessa");
    // t≈1447: "não vai ter mais roubalheira ... no governo Bolsonaro" (Flávio) reescrito no passado
    const inss = "o Brasil elegeu agora 1 congresso nacional muito mais à direita Lula, e não vai ter mais roubalheira de velhinho no no governo Bolsonaro, e no seu governo está tendo";
    expect(run(claim("não vai ter mais roubalheira de velhinho no no governo Bolsonaro", "Não houve mais roubalheira contra aposentados no governo Bolsonaro.", { tipo: "acusacao" }), inss, FLAVIO).dropped)
      .toBe("promessa");
    // t≈5563: "eu vou devolver ... quem vai andar com medo" virou fato no presente
    const medo = "Eu vou devolver de verdade a segurança para você, as ruas vão voltar a ser nossas, e não dos marginais hoje, quem vai andar com medo nas ruas, são esses marginais.";
    expect(run(claim("quem vai andar com medo nas ruas, são esses marginais", "Hoje, quem anda com medo nas ruas são os criminosos, e não a população.",
      { tipo: "opiniao_mensuravel", measurable: "sensação de segurança (Datafolha)" }), medo, FLAVIO).dropped).toBe("promessa");
    // t≈5771 (Lula): "vou chegar até 300 bilhões" é promessa; o "nós lançamos 1 MP" da mesma frase, não
    const desenrola = "Ele sabe nós lançamos 1 medida provisória, comprando dívida, vou chegar até 300000000000, fazendo leilão nos bancos, para que as pessoas que estão em dívida vai ter 1 desconto de até 92 por 100, para que a gente possa dar 1 recomeço para o povo.";
    expect(run(claim("comprando dívida, vou chegar até 300000000000", "O governo Lula vai comprar até R$ 300 bilhões em dívidas.", { tipo: "estatistica" }), desenrola, LULA).dropped)
      .toBe("promessa");
    expect(run(claim("nós lançamos 1 medida provisória, comprando dívida", "O governo Lula lançou uma medida provisória para comprar dívidas."), desenrola, LULA).out)
      .toHaveLength(1);
  });

  it("contraexemplos: futuro sem mandato do falante, lei com efeito futuro, fala de condução e passado passam", () => {
    expect(isPromise("o Brasil vai crescer 3% no ano que vem", "o Brasil vai crescer 3% no ano que vem")).toBe(false);
    expect(isPromise("quem ganha até 5 mil não vai pagar imposto de renda", "a partir de janeiro, quem ganha até 5 mil não vai pagar imposto de renda")).toBe(false);
    expect(isPromise("o desemprego caiu para 5,6%", "eu vou te dizer uma coisa: o desemprego caiu para 5,6%")).toBe(false);
    expect(isPromise("eu vou te dizer uma coisa: o desemprego caiu para 5,6%", "")).toBe(false);
    expect(isPromise("que hoje atende 20 milhões de famílias", "eu vou manter o bolsa família, que hoje atende 20 milhões de famílias")).toBe(false);
    expect(isPromise("no meu governo o desemprego caiu para 6,6%", "no meu governo o desemprego caiu para 6,6%", ["lula"])).toBe(false);
    // "governo Bolsonaro" no futuro só é promessa na boca do Flávio
    expect(isPromise("não vai ter mais roubalheira no governo Bolsonaro", "não vai ter mais roubalheira no governo Bolsonaro", ["lula"])).toBe(false);
    // lei com efeito futuro é fato, não promessa do falante: passa a trava e continua checável
    expect(run(claim("quem ganha até 5 mil não vai pagar imposto de renda", "Quem ganha até R$ 5 mil não vai pagar imposto de renda.", {
      tipo: "fato", time_reference: null,
    }), "a partir de janeiro, quem ganha até 5 mil não vai pagar imposto de renda", LULA).out).toHaveLength(1);
  });
});

describe("[RF02] [RF03] fato de referência: \"há N anos\" é tempo total, e a unidade tem de ser dita", () => {
  const SRC = { fonte_nome: "Biblioteca da Presidência da República", fonte_url: "https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes", trecho: "t", notas: null };
  const MANDATES: RefMandate[] = [
    { id: "lula-2003", pessoa: "Luiz Inácio Lula da Silva", partido: "PT", inicio: "2003-01-01", fim: "2011-01-01", papel: "titular", ...SRC },
    { id: "bolsonaro-pl", pessoa: "Jair Messias Bolsonaro", partido: "PL", inicio: "2019-01-01", fim: "2023-01-01", papel: "titular", ...SRC },
    { id: "lula-2023", pessoa: "Luiz Inácio Lula da Silva", partido: "PT", inicio: "2023-01-01", fim: null, papel: "titular", ...SRC },
  ];
  const ref = (over: Partial<ReferenceRef> = {}): ReferenceRef => ({
    type: "tempo_no_poder", subject: "Lula", window_years: 12, year: null, round: null, claimed_value: 12, unit: "anos", qualifier: "exato", ...over,
  });
  const HA_12 = "da dificuldade de governar esse país, porque já governo o país há 12 anos. E tenho orgulho de ter sido o 1º presidente da república a conseguir 2 grau de investimento nesse país.";

  it("\"já governo o país há 12 anos\" (t≈638) ⇒ janela nula ⇒ confirmado (~11,8 anos), nunca contradito", () => {
    const { out } = run(claim("já governo o país há 12 anos", "Lula governa o Brasil há 12 anos.", { reference: ref() }), HA_12, LULA);
    expect(out[0]!.reference).toMatchObject({ window_years: null, claimed_value: 12 });
    const total = timeInPower(out[0]!.reference!, MANDATES, "2026-10-18").comparison;
    expect(total).toMatchObject({ status: "match", expected_verdict: "confirmado" });
    expect(total.actual).toBeCloseTo(11.8, 1);
    // o que o ensaio fez: janela de 12 anos ⇒ 3,8 anos ⇒ contradito
    expect(timeInPower(ref(), MANDATES, "2026-10-18").comparison.expected_verdict).toBe("contradito");
  });

  it("janela dita (\"20 dos últimos 24\") continua janela; janela igual ao valor vira total", () => {
    expect(windowAsTotal(ref({ subject: "PT", window_years: 24, claimed_value: 20 }), "o PT governou 20 dos últimos 24 anos")!.window_years).toBe(24);
    expect(windowAsTotal(ref({ subject: "PT", window_years: 24, claimed_value: 20 }), "faz 24 anos que o PT governa 20 dos últimos 24 anos")!.window_years).toBe(24);
    expect(windowAsTotal(ref(), "governou 12 anos")!.window_years).toBeNull();
    expect(windowAsTotal(ref({ window_years: 20, claimed_value: 8 }), "o PT está aí há 20 anos")!.window_years).toBeNull();
  });

  it("no pipeline o verificador recebe a conta do tempo total", async () => {
    const store = new MemoryStore({ mandates: MANDATES });
    let verifyMsg = "";
    const deps = makeDeps({
      store, now: () => Date.parse("2026-10-18T23:00:00Z"),
      anthropic: fakeAnthropic({
        extract: () => ({ output: { claims: [claim("já governo o país há 12 anos", "Lula governa o Brasil há 12 anos.", { reference: ref() })] } }),
        verify: (u) => ((verifyMsg = u), SILENT),
      }),
    });
    await createPipeline(deps).runPipeline(store.addSegment(HA_12).id);
    expect(verifyMsg).toContain("até 18/10/2026: 11,8 anos");
    expect(verifyMsg).not.toContain("nos últimos 12 anos");
  });

  it("\"fica quase 22. presidente ... Bolsonaro\" (t≈1744, vermelho rejeitado pelo editor) não vira \"22 anos\"", () => {
    const seg = "dinheiro Gente, fica quase 22. presidente do Brasil que já existiu que é GMCs Bolsonaro, você conhece? O melhor presidente do Brasil e vai ser 1 filme maravilhoso. Eu boate para você assistir o filme do Bolsonaro";
    const c = claim("fica quase 22. presidente do Brasil que já existiu que é GMCs Bolsonaro", "Bolsonaro foi presidente do Brasil por quase 22 anos.", {
      reference: { type: "tempo_no_poder", subject: "Bolsonaro", window_years: null, year: null, round: null, claimed_value: 22, unit: "anos", qualifier: "quase" },
    });
    expect(run(c, seg, FLAVIO).dropped).toBe("unidade_inventada");
    expect(run({ ...c, transcricao_duvidosa: true }, seg, FLAVIO).dropped).toBe("transcricao_duvidosa");
    expect(referenceUnitMissing(ref({ type: "eleicao", unit: "votos", year: 2022, round: 2 }), "no segundo turno de 2022 eu tive 60 milhões de votos")).toBe(false);
    expect(referenceUnitMissing(ref({ type: "eleicao", unit: "%", year: 2026, round: 1 }), "tive 47 por 100 no primeiro turno de 2026")).toBe(false);
    expect(referenceUnitMissing(ref({ type: "eleicao", unit: "votos", year: 2026, round: 1 }), "56 milhões de brasileiros no primeiro turno de 2026")).toBe(true);
  });
});

describe("[RF02] transcrição embaralhada não vira afirmação", () => {
  it("o extrator marca transcricao_duvidosa ⇒ descarta (\"secretário do ferro\", \"essa maior de terras indígena\")", () => {
    const ferro = "Nada, é tudo médico particular. E ele fala eu vou trazer o presidente do Eiberg, é importante ser também que ele já foi secretário do ferro e não deu certo.";
    expect(run(claim("ele já foi secretário do ferro e não deu certo", "Ele já foi secretário do ferro e não deu certo.", { transcricao_duvidosa: true }), ferro, LULA).dropped)
      .toBe("transcricao_duvidosa");
    const ti = "O modelo que fez a maior inclusão da história desse país. O modelo que fez com que, sabe, a gente fez essa maior de terras indígena desse país.";
    expect(run(claim("a gente fez essa maior de terras indígena desse país.", "O governo do PT demarcou a maior extensão de terras indígenas da história do Brasil.", {
      tipo: "opiniao_mensuravel", measurable: "terras indígenas homologadas por governo", transcricao_duvidosa: true,
    }), ti, LULA).dropped).toBe("transcricao_duvidosa");
    // o campo é obrigatório na saída estruturada (o modelo sempre decide)
    expect(ExtractionSchema.safeParse({ claims: [{ ...claim("x", "y"), transcricao_duvidosa: undefined }] }).success).toBe(false);
  });

  it("número que a transcrição embaralhou cai quando a afirmação o usa (\"90 e por 100\", \"2.8 por 102.8\", \"0 1 por 100\")", () => {
    const priv = "Eles querem privatizar, ele já falou, quero privatizar 90 e por 100 das estatais brasileiras.";
    expect(run(claim("ele já falou, quero privatizar 90 e por 100 das estatais brasileiras", "Flávio Bolsonaro disse que quer privatizar 90% das estatais brasileiras.", {
      tipo: "estatistica",
    }), priv, LULA).dropped).toBe("numero_embaralhado");
    const deficit = "1 déficit de 2.8 por 102.8. Nós não só reduzimos como agora apresentamos 1 orçamento com superávit de 0 1 por 100. É a 1º vez.";
    expect(run(claim(deficit, "O governo reduziu o déficit primário de 2,8% do PIB e agora apresentou um orçamento com superávit primário de 0,1% do PIB.", {
      tipo: "estatistica",
    }), deficit, LULA).dropped).toBe("numero_embaralhado");
    expect(garbledNumber("apresentamos 1 orçamento com superávit de 0 1 por 100")).toBe("0 1 por 100");
    expect(garbledNumber("Agora, nos meus 4 anos, está 13 por 104 vezes menos.")).toBe("13 por 104");
  });

  it("contraexemplos: \"N por 100\" limpo é N% e taxa por 100 mil não é embaralhada", () => {
    expect(garbledNumber("73 por 100 dos presidiários votaram em você?")).toBeNull();
    expect(garbledNumber("são 20 por 100000 habitantes")).toBeNull();
    expect(garbledNumber("são 20 por 100.000 habitantes")).toBeNull();
    expect(garbledNumber("cresceu 7 e meio por 100")).toBeNull();
    expect(garbledNumber("se o PIB cresceu 3 ou 4 por 100")).toBeNull();
    expect(garbledNumber("em 2022 3 por 100 dos jovens")).toBeNull();
    expect(garbledNumber("desconto de até 92 por 100")).toBeNull();
    expect(garbledNumber("foi aprovada por 105 votos")).toBeNull();
  });
});

describe("[RF02] prompt do extrator (mudanças pequenas e explícitas)", () => {
  it("lista de fatos vira uma afirmação por item; estatística não fica de fora; pessoa de quem fala; janela", () => {
    expect(EXTRACT_SYSTEM).toMatch(/lista de fatos \("recorde de X, recorde de Y, recorde de Z"\) vira uma afirmação por item/);
    expect(EXTRACT_SYSTEM).toMatch(/mistura opinião ou previsão com uma estatística, a estatística também sai/);
    expect(EXTRACT_SYSTEM).toMatch(/QUEM FALA/);
    expect(EXTRACT_SYSTEM).toMatch(/"governo há 12 anos" é tempo total → window_years null/);
    expect(EXTRACT_SYSTEM).toMatch(/transcricao_duvidosa: true/);
    // sem mapa, a mensagem fica como antes (só o rótulo)
    const semMapa = buildExtractMessage({ text: "x", context: "", speaker_label: "s1:S4", today: "2026-10-23" });
    expect(semMapa).toContain('<fala_atual locutor="s1:S4">');
    expect(semMapa).not.toContain("Quem fala agora");
  });

  it("frase da afirmação: ponto de número não corta, e o trecho não achado volta inteiro", () => {
    expect(sentenceOf("o déficit foi de 2.8 por 100", "Antes. Olha, o déficit foi de 2.8 por 100 no governo deles. Depois.")).toBe("olha, o deficit foi de 2.8 por 100 no governo deles.");
    expect(sentenceOf("não está aqui", "Outra coisa.")).toBe("nao esta aqui");
  });
});
