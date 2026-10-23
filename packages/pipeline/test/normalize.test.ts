import type { IndicatorRef } from "@actually/db";
import { describe, expect, it } from "vitest";
import {
  canonicalUnit, claimHash, extractNumbers, normalizeClaimNumbers, normalizeText, numberSignature,
  parseNumericLiteral, parsePtBrNumber, polaritySignature, sameFacts, wordingKey,
} from "../src/normalize";

describe("normalizeText / claimHash", () => {
  it("ignora acento, caixa, pontuação e espaços", () => {
    expect(normalizeText("  O Desemprego  CAIU, em 2023!  ")).toBe("o desemprego caiu em 2023");
    expect(normalizeText("Ação é ótima")).toBe("acao e otima");
    expect(claimHash("O desemprego caiu em 2023.")).toBe(claimHash("o desemprego   caiu em 2023"));
    expect(claimHash("O desemprego caiu em 2023.")).not.toBe(claimHash("O desemprego caiu em 2022."));
    expect(claimHash("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("números pt-BR", () => {
  it("literais", () => {
    expect(parseNumericLiteral("1.500")).toBe(1500);
    expect(parseNumericLiteral("6,5")).toBe(6.5);
    expect(parseNumericLiteral("1.234,56")).toBe(1234.56);
    expect(parseNumericLiteral("1.5")).toBe(1.5);
    expect(parseNumericLiteral("2022")).toBe(2022);
  });

  it("1,5 milhão", () => {
    expect(parsePtBrNumber("1,5 milhão")).toEqual({ value: 1_500_000, unit: null, raw: "1,5 milhão" });
  });

  it("6% e 6,5 por cento", () => {
    expect(parsePtBrNumber("6%")).toMatchObject({ value: 6, unit: "%" });
    expect(parsePtBrNumber("6,5 por cento")).toMatchObject({ value: 6.5, unit: "%" });
  });

  it("\"e meio\" vale meia unidade da escala dita (ensaio da Band: \"cresceu 7 e meio\")", () => {
    expect(parsePtBrNumber("7 e meio")).toEqual({ value: 7.5, unit: null, raw: "7 e meio" });
    expect(parsePtBrNumber("2 e meia")).toMatchObject({ value: 2.5 });
    expect(parsePtBrNumber("3 bilhões e meio")).toMatchObject({ value: 3_500_000_000 });
    expect(parsePtBrNumber("R$ 3 bi e meio")).toMatchObject({ value: 3_500_000_000, unit: "R$" });
    // número grande já em dígitos: a escala não está dita, somar 0,5 bilhão seria chute
    expect(parsePtBrNumber("3000000000 e meio")).toMatchObject({ value: 3_000_000_000 });
    // "meio milhão" (sem número antes) continua valendo pelo dicionário de palavras
    expect(parsePtBrNumber("meio milhão")).toMatchObject({ value: 500_000 });
  });

  it("quase 10 milhões (qualificador fica no raw)", () => {
    expect(parsePtBrNumber("quase 10 milhões")).toEqual({ value: 10_000_000, unit: null, raw: "quase 10 milhões" });
  });

  it("R$ 600 e R$ 1,2 trilhão", () => {
    expect(parsePtBrNumber("R$ 600")).toMatchObject({ value: 600, unit: "R$" });
    expect(parsePtBrNumber("R$ 1,2 trilhão")).toMatchObject({ value: 1.2e12, unit: "R$" });
    expect(parsePtBrNumber("600 reais")).toMatchObject({ value: 600, unit: "R$" });
  });

  it("por extenso e mil", () => {
    expect(parsePtBrNumber("dez milhões de empregos")).toMatchObject({ value: 1e7 });
    expect(parsePtBrNumber("meio milhão")).toMatchObject({ value: 500_000 });
    expect(parsePtBrNumber("50 mil")).toMatchObject({ value: 50_000 });
    expect(parsePtBrNumber("3 pontos percentuais")).toMatchObject({ value: 3, unit: "p.p." });
  });

  it("vários números numa frase", () => {
    const ns = extractNumbers("Em 2023 o desemprego foi de 7,8%, e 1,5 milhão de pessoas saíram da fila.");
    expect(ns.map((n) => [n.value, n.unit])).toEqual([[2023, null], [7.8, "%"], [1_500_000, null]]);
  });

  it("não inventa número de texto sem número", () => {
    expect(extractNumbers("Eu criei o Bolsa Família.")).toEqual([]);
    expect(parsePtBrNumber("dez")).toBeNull();
  });

  it("unidades canônicas", () => {
    expect(canonicalUnit("%")).toBe("%");
    expect(canonicalUnit("pontos percentuais")).toBe("p.p.");
    expect(canonicalUnit("p.p.")).toBe("p.p.");
    expect(canonicalUnit("reais")).toBe("R$");
    expect(canonicalUnit("km²")).toBe("km2");
    expect(canonicalUnit(null)).toBeNull();
  });

  it("normalizeClaimNumbers prefere o parse determinístico do raw", () => {
    expect(normalizeClaimNumbers([{ value: 1.5, unit: "milhão", raw: "1,5 milhão" }])).toEqual([
      { value: 1_500_000, unit: null, raw: "1,5 milhão" },
    ]);
    expect(normalizeClaimNumbers([{ value: 7, unit: "por cento", raw: "sete" }])).toEqual([
      { value: 7, unit: "%", raw: "sete" },
    ]);
  });
});

describe("assinatura numérica e polaridade", () => {
  const ind = null;
  it("números diferentes ⇒ fatos diferentes", () => {
    expect(sameFacts({ text_normalized: "O desemprego em 2023 foi 6%", indicator: ind }, { text_normalized: "O desemprego em 2023 foi 8%", indicator: ind })).toBe(false);
  });
  it("mesmo número escrito de outro jeito ⇒ mesmo fato", () => {
    expect(numberSignature("1,5 milhão de empregos", null)).toEqual(numberSignature("1.500.000 empregos", null));
    expect(sameFacts({ text_normalized: "Foram criados 1,5 milhão de empregos em 2023", indicator: ind }, { text_normalized: "Foram criados 1.500.000 de empregos em 2023", indicator: ind })).toBe(true);
  });
  it("período diferente ⇒ fatos diferentes", () => {
    expect(sameFacts({ text_normalized: "desemprego 6% em 2023", indicator: ind }, { text_normalized: "desemprego 6% em 2022", indicator: ind })).toBe(false);
  });
  it("subiu x caiu, e negação", () => {
    expect(polaritySignature("o desemprego caiu")).not.toBe(polaritySignature("o desemprego subiu"));
    expect(sameFacts({ text_normalized: "O desmatamento caiu no governo", indicator: ind }, { text_normalized: "O desmatamento aumentou no governo", indicator: ind })).toBe(false);
    expect(sameFacts({ text_normalized: "Ele votou a favor da PEC", indicator: ind }, { text_normalized: "Ele não votou a favor da PEC", indicator: ind })).toBe(false);
  });
});

describe("[RF06] trava por similaridade: polaridade e direção opostas nunca são a mesma afirmação", () => {
  const same = (a: string, b: string, ia: IndicatorRef | null = null, ib: IndicatorRef | null = null) =>
    sameFacts({ text_normalized: a, indicator: ia }, { text_normalized: b, indicator: ib });

  it.each([
    ["O senador Flávio Bolsonaro votou a favor da PEC da Transição em 2022.", "O senador Flávio Bolsonaro votou contra a PEC da Transição em 2022."],
    ["Em 2024 o Brasil teve a menor taxa de desemprego da série histórica.", "Em 2024 o Brasil teve a maior taxa de desemprego da série histórica."],
    ["A dívida pública aumentou em 2023.", "A dívida pública diminuiu em 2023."],
    ["O governo teve superávit primário em 2023.", "O governo teve déficit primário em 2023."],
    ["A Câmara aprovou a reforma tributária em 2023.", "A Câmara rejeitou a reforma tributária em 2023."],
    ["O deputado votou sim na reforma da Previdência em 2019.", "O deputado votou não na reforma da Previdência em 2019."],
    ["O presidente sancionou a lei do marco temporal em 2023.", "O presidente vetou a lei do marco temporal em 2023."],
    ["Mais de 10 milhões de famílias recebem o Bolsa Família.", "Menos de 10 milhões de famílias recebem o Bolsa Família."],
    ["A inflação ficou acima da meta em 2024.", "A inflação ficou abaixo da meta em 2024."],
    ["O saldo da balança comercial foi positivo em 2023.", "O saldo da balança comercial foi negativo em 2023."],
    ["O governo Lula criou o programa Mais Médicos.", "O governo Lula extinguiu o programa Mais Médicos."],
    ["O governo privatizou a Eletrobras em 2022.", "O governo estatizou a Eletrobras em 2022."],
    ["O STF considerou a lei constitucional em 2024.", "O STF considerou a lei inconstitucional em 2024."],
    ["O emprego industrial caiu em 2023.", "O desemprego industrial caiu em 2023."],
  ])("%s × %s ⇒ fatos diferentes", (a, b) => {
    expect(same(a, b)).toBe(false);
    expect(same(b, a)).toBe(false);
  });

  it("mesmos termos em outra ordem numa comparação ⇒ fatos diferentes", () => {
    expect(same("O Brasil cresceu mais que a Argentina em 2023.", "A Argentina cresceu mais que o Brasil em 2023.")).toBe(false);
    expect(same(
      "No governo Lula foram criados mais empregos do que no governo Bolsonaro.",
      "No governo Bolsonaro foram criados mais empregos do que no governo Lula.",
    )).toBe(false);
  });

  it("sujeito diferente (nome próprio) ⇒ fatos diferentes", () => {
    expect(same("Lula criou o Bolsa Família em 2003.", "Fernando Henrique criou o Bolsa Família em 2003.")).toBe(false);
  });

  it("indicador: min x max, nível x variação ⇒ fatos diferentes", () => {
    const base: IndicatorRef = { query: "desemprego", period: "2024", claimed_value: null, unit: "%", kind: "min" };
    const text = "Em 2024 o desemprego foi o recorde da série.";
    expect(same(text, text, base, { ...base, kind: "max" })).toBe(false);
    expect(same(text, text, { ...base, claimed_value: 6, kind: "level" }, { ...base, claimed_value: 6, kind: "change_pct" })).toBe(false);
    expect(numberSignature(text, base)).toContain("tipo:min");
  });

  it("só grafia de número, artigo, caixa, acento e pontuação ⇒ mesma afirmação", () => {
    expect(same("O salário mínimo é de R$ 1.518.", "o salario minimo e de 1.518 reais")).toBe(true);
    expect(same("O desemprego em 2023 foi de 12%.", "Desemprego em 2023 foi de 12 por cento")).toBe(true);
    expect(same("Foram criados 1,5 milhão de empregos em 2023", "Foram criados 1.500.000 de empregos em 2023")).toBe(true);
    expect(wordingKey("O salário mínimo é de R$ 1.518,00.")).toBe("salario minimo e de #R$:1518");
  });

  it("paráfrase com outra palavra ou outra ordem ⇒ verifica de novo (custa latência, nunca precisão)", () => {
    expect(same("O desemprego foi de 12% em 2023.", "Em 2023, a taxa de desemprego chegou a 12%.")).toBe(false);
    expect(same("Em 2023, o Brasil cresceu mais que a Argentina.", "O Brasil cresceu mais que a Argentina em 2023.")).toBe(false);
    expect(same("O senador Flávio Bolsonaro votou contra a PEC da Transição.", "O senador Flávio Bolsonaro votou contra a PEC da Transição em plenário.")).toBe(false);
  });
});

describe("[RF06] trava por similaridade: qualquer palavra trocada, a mais ou fora de ordem ⇒ não é a mesma afirmação", () => {
  const same = (a: string, b: string) => sameFacts({ text_normalized: a, indicator: null }, { text_normalized: b, indicator: null });

  // trocas de uma palavra que mudam o sentido e não estão em nenhuma lista de antônimos
  it.each([
    ["O Brasil exportou 1 milhão de barris de petróleo por dia em 2023.", "O Brasil importou 1 milhão de barris de petróleo por dia em 2023."],
    ["O candidato foi condenado em 2017.", "O candidato foi absolvido em 2017."],
    ["O ex-presidente foi preso em 2018.", "O ex-presidente foi solto em 2018."],
    ["A gasolina ficou mais cara em 2022.", "A gasolina ficou mais barata em 2022."],
    ["O país teve inflação em 2023.", "O país teve deflação em 2023."],
    ["O investimento público caiu 10% em 2023.", "O investimento privado caiu 10% em 2023."],
    ["O governo comprou 10 mil vacinas em 2021.", "O governo vendeu 10 mil vacinas em 2021."],
    ["Os ricos pagam 10% de imposto de renda.", "Os pobres pagam 10% de imposto de renda."],
    ["A taxa de homicídios entre brancos caiu 20% em 2022.", "A taxa de homicídios entre negros caiu 20% em 2022."],
    ["A dívida federal chegou a 80% do PIB em 2023.", "A dívida estadual chegou a 80% do PIB em 2023."],
    ["O desemprego urbano foi de 8% em 2023.", "O desemprego rural foi de 8% em 2023."],
    ["o pt votou pela pec em 2022.", "o pl votou pela pec em 2022."],
    ["O dólar se valorizou 10% em 2024.", "O real se valorizou 10% em 2024."],
    // mesmas palavras, outra ordem (quem deve a quem; de onde para onde)
    ["O Brasil deve 10 bilhões à Venezuela.", "A Venezuela deve 10 bilhões ao Brasil."],
    ["A Selic passou de 10% para 15%.", "A Selic passou de 15% para 10%."],
    // preposição muda o fato
    ["A inflação caiu para 4% em 2024.", "A inflação caiu 4% em 2024."],
    ["O desemprego caiu até 2022.", "O desemprego caiu em 2022."],
    // número por extenso sem multiplicador, multiplicador ou moeda soltos, qualificador
    ["O Brasil teve dois presidentes afastados.", "O Brasil teve três presidentes afastados."],
    ["Mil pessoas morreram nas enchentes de 2024.", "Milhões de pessoas morreram nas enchentes de 2024."],
    ["A dívida em dólares cresceu em 2023.", "A dívida em reais cresceu em 2023."],
    ["O desemprego foi de quase 10% em 2021.", "O desemprego foi de 10% em 2021."],
  ])("%s × %s ⇒ fatos diferentes", (a, b) => {
    expect(same(a, b)).toBe(false);
    expect(same(b, a)).toBe(false);
  });
});

describe("[RF06] qualificador aproximado conta na redação", () => {
  it("[RF06] \"uns 10 milhões\" não é a mesma afirmação que \"10 milhões\"", () => {
    expect(wordingKey("O Brasil tem uns 10 milhões de desempregados.")).not.toBe(wordingKey("O Brasil tem 10 milhões de desempregados."));
  });

  it("[RF06] preposição de lugar/tempo não muda o fato; de direção muda (ensaio de 21/10: \"em\" x \"por\")", () => {
    const same = (a: string, b: string) => sameFacts({ text_normalized: a, indicator: null }, { text_normalized: b, indicator: null });
    expect(same("O PT governou o Brasil em 20 dos últimos 24 anos.", "O PT governou o Brasil por 20 dos últimos 24 anos.")).toBe(true);
    expect(same("O desemprego caiu para 6%.", "O desemprego caiu de 6%.")).toBe(false);
    expect(same("O desemprego caiu para 6% em 2023.", "O desemprego caiu para 6% em 2024.")).toBe(false);
    expect(wordingKey("O Brasil tem umas 10 mil escolas.")).not.toBe(wordingKey("O Brasil tem 10 mil escolas."));
    expect(wordingKey("O Brasil tem quase 10 milhões de desempregados.")).not.toBe(wordingKey("O Brasil tem 10 milhões de desempregados."));
  });
});
