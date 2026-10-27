import { describe, expect, it } from "vitest";
import {
  bestWindowDistance, dropUnverifiedCitationDates, levenshtein, normalizeForQuote, numbersSupported, quoteCheck, wordNumbers,
} from "../src/quoteCheck";

const SOURCE = `A taxa de desocupação no Brasil ficou em 7,8% na média de 2023, segundo a PNAD Contínua divulgada pelo IBGE.
O número de pessoas desocupadas recuou para 8,5 milhões — o menor contingente desde 2015.
"É um resultado consistente", disse a coordenadora da pesquisa.`;

describe("normalizeForQuote", () => {
  it("unifica aspas, travessões, acentos e espaços", () => {
    expect(normalizeForQuote("“É  um” resultado — ok…")).toBe('"e um" resultado - ok...');
  });
});

describe("[RF05] quoteCheck", () => {
  it("substring exata após normalização", () => {
    const r = quoteCheck("a taxa de desocupacao no brasil ficou em 7,8% na media de 2023", SOURCE);
    expect(r).toMatchObject({ verified: true, method: "exact", similarity: 1 });
  });

  it("aceita aspas tipográficas trocadas e travessão diferente", () => {
    expect(quoteCheck("desocupadas recuou para 8,5 milhões - o menor contingente desde 2015", SOURCE).verified).toBe(true);
    expect(quoteCheck("\"É um resultado consistente\", disse a coordenadora", SOURCE).verified).toBe(true);
  });

  it("fuzzy só tolera pontuação/espaço: mesmas palavras e números (≥ 0,9)", () => {
    const r = quoteCheck("A taxa de desocupaçao no Brasil ficou em 7,8% na média de 2023 segundo a PNAD Contínua", SOURCE);
    expect(r.verified).toBe(true);
    expect(r.method).toBe("fuzzy");
    expect(r.similarity).toBeGreaterThanOrEqual(0.9);
  });

  it("qualquer palavra trocada, mesmo curta, não passa (na dúvida, não verificada)", () => {
    expect(quoteCheck("A taxa de desocupaçao no Brasil ficou em 7,8% na média do 2023", SOURCE).verified).toBe(false);
  });

  it("trecho verificado devolve o texto LITERAL da fonte, não o do modelo", () => {
    const r = quoteCheck("a taxa de desocupacao no brasil ficou em 7,8% na media de 2023 segundo a pnad continua", SOURCE);
    expect(r).toMatchObject({ verified: true, method: "fuzzy" });
    expect(r.matched).toBe("A taxa de desocupação no Brasil ficou em 7,8% na média de 2023, segundo a PNAD Contínua");
    const e = quoteCheck("“É um resultado consistente”, disse a coordenadora", SOURCE);
    expect(e.matched).toBe('É um resultado consistente", disse a coordenadora');
    // quebras de linha da fonte viram espaço
    const multi = quoteCheck("divulgada pelo IBGE. O número de pessoas desocupadas", SOURCE);
    expect(multi).toMatchObject({ verified: true, method: "exact", matched: "divulgada pelo IBGE. O número de pessoas desocupadas" });
  });

  it("não verificado ⇒ sem trecho da fonte", () => {
    expect(quoteCheck("O desemprego médio de 2023 foi de 7,8 por cento de acordo com o IBGE", SOURCE)).toMatchObject({
      verified: false, matched: null, context: null,
    });
  });

  it("número/data trocado por outro que existe em outra frase da fonte não passa", () => {
    // 8,5 e 2015 existem na fonte, mas não nesta frase
    expect(quoteCheck("A taxa de desocupação no Brasil ficou em 8,5% na média de 2015, segundo a PNAD Contínua divulgada pelo IBGE", SOURCE).verified).toBe(false);
    expect(quoteCheck("A taxa de desocupação no Brasil ficou em 8,5%", SOURCE).verified).toBe(false);
  });

  it("antônimo não passa", () => {
    expect(quoteCheck("O número de pessoas desocupadas recuou para 8,5 milhões — o maior contingente desde 2015", SOURCE).verified).toBe(false);
    const S = "No terceiro trimestre, segundo o IBGE, o número de pessoas ocupadas aumentou em relação ao trimestre anterior. A taxa de desocupação ficou estável no período.";
    expect(quoteCheck("o número de pessoas ocupadas diminuiu em relação ao trimestre anterior", S).verified).toBe(false);
    expect(quoteCheck("a taxa de desocupação ficou instável no período", S).verified).toBe(false);
    expect(quoteCheck("o número de pessoas ocupadas aumentou em relação ao trimestre anterior", S).verified).toBe(true);
  });

  it("negação removida ou inserida não passa (não/nunca/jamais/nem/sem)", () => {
    const S = "Segundo o IBGE, a taxa de desocupação não caiu no terceiro trimestre de 2024, permanecendo estável em 6,4%.";
    expect(quoteCheck("a taxa de desocupação não caiu no terceiro trimestre de 2024, permanecendo estável em 6,4%", S).verified).toBe(true);
    expect(quoteCheck("a taxa de desocupação caiu no terceiro trimestre de 2024, permanecendo estável em 6,4%", S).verified).toBe(false);
    expect(quoteCheck("a taxa de desocupação caiu no terceiro trimestre de 2024", S).verified).toBe(false);
    for (const neg of ["nunca", "jamais", "nem", "sem"]) {
      expect(quoteCheck(`O número de pessoas desocupadas ${neg} recuou para 8,5 milhões`, SOURCE).verified).toBe(false);
    }
    expect(quoteCheck("a taxa de desocupação no Brasil não ficou em 7,8% na média de 2023", SOURCE).verified).toBe(false);
  });

  it("trecho que começa/termina no meio de palavra ou número não passa", () => {
    expect(quoteCheck("8% na média de 2023, segundo a PNAD", SOURCE).verified).toBe(false); // de "7,8%"
    expect(quoteCheck("taxa de desocupação no Brasil ficou em 7", SOURCE).verified).toBe(false); // de "7,8%"
    expect(quoteCheck("constitucional segundo o STF", "A lei foi declarada inconstitucional segundo o STF.").verified).toBe(false);
    // sinal do número faz parte dele
    const S = "O PIB variou -0,5% no trimestre, segundo o IBGE.";
    expect(quoteCheck("0,5% no trimestre, segundo o IBGE", S).verified).toBe(false);
    expect(quoteCheck("-0,5% no trimestre, segundo o IBGE", S)).toMatchObject({ verified: true, matched: "-0,5% no trimestre, segundo o IBGE" });
    expect(quoteCheck("o PIB variou 0,5% no trimestre", S).verified).toBe(false);
    expect(quoteCheck("-2,1% no ano, segundo o IBGE", "O PIB variou +2,1% no ano, segundo o IBGE.").verified).toBe(false);
    // intervalo de anos não é sinal
    expect(quoteCheck("a série de 2015-2023 mostra queda", "Segundo o IBGE, a série de 2015–2023 mostra queda.").verified).toBe(true);
  });

  it("context: frase da fonte em volta do trecho, sem atravessar linha nem outra frase", () => {
    const S = "Afirmação checada: atende 30 milhões de famílias\nClassificação: Exagerado\nEm setembro de 2026, o Bolsa Família pagou benefícios a 20,8 milhões de famílias, segundo o MDS. Outra frase com 99 mil.";
    const r = quoteCheck("o Bolsa Família pagou benefícios a 20,8 milhões de famílias", S);
    expect(r.context).toBe("Em setembro de 2026, o Bolsa Família pagou benefícios a 20,8 milhões de famílias, segundo o MDS.");
  });

  it("rejeita número trocado (não é a mesma citação)", () => {
    const r = quoteCheck("A taxa de desocupação no Brasil ficou em 9,8% na média de 2021", SOURCE);
    expect(r.verified).toBe(false);
    // um único dígito trocado num texto longo ainda passaria no fuzzy puro — número não tem tolerância
    expect(quoteCheck("A taxa de desocupação no Brasil ficou em 7,9% na média de 2023, segundo a PNAD Contínua", SOURCE).verified).toBe(false);
  });

  it("rejeita paráfrase", () => {
    expect(quoteCheck("O desemprego médio de 2023 foi de 7,8 por cento de acordo com o IBGE", SOURCE).verified).toBe(false);
  });

  it("rejeita citação curta demais", () => {
    expect(quoteCheck("7,8%", SOURCE).verified).toBe(false);
  });

  it("elipse não junta trechos distantes nem fora de ordem", () => {
    expect(quoteCheck("A taxa de desocupação no Brasil [...] segundo a PNAD Contínua divulgada pelo IBGE", SOURCE).verified).toBe(false);
    expect(quoteCheck("A taxa de desocupação no Brasil … segundo a PNAD Contínua divulgada pelo IBGE", SOURCE).verified).toBe(false);
    expect(quoteCheck("segundo a PNAD Contínua divulgada pelo IBGE ... A taxa de desocupação no Brasil", SOURCE).verified).toBe(false);
    // juntar partes muda o sentido: o documento NÃO prevê a privatização
    const PROG = "O programa de governo do candidato prevê ampliar o Bolsa Família. Em outro capítulo, critica quem defende a privatização da Petrobras e dos Correios.";
    expect(quoteCheck("O programa de governo do candidato prevê [...] a privatização da Petrobras e dos Correios", PROG).verified).toBe(false);
    expect(quoteCheck("O programa de governo do candidato prevê (...) a privatização da Petrobras e dos Correios", PROG).verified).toBe(false);
    // parte fuzzy seguida de parte anterior na fonte: ordem continua exigida
    const ORD = "Primeira frase bem longa aqui sobre economia. Segunda frase também longa sobre saúde pública.";
    expect(quoteCheck("Segunda frase tambem longa sobre saude publica ... Primeira frase bem longa aqui", ORD).verified).toBe(false);
  });

  it("elipse no começo/fim é só borda; elipse que não omite palavra nenhuma vira o trecho contíguo da fonte", () => {
    expect(quoteCheck("[...] A taxa de desocupação no Brasil ficou em 7,8%…", SOURCE)).toMatchObject({ verified: true, method: "exact" });
    const r = quoteCheck("segundo a PNAD Contínua... divulgada pelo IBGE", SOURCE);
    expect(r).toMatchObject({ verified: true, method: "fuzzy", matched: "segundo a PNAD Contínua divulgada pelo IBGE" });
  });

  it("fonte vazia ⇒ não verificada", () => {
    expect(quoteCheck("qualquer coisa longa o bastante", "").verified).toBe(false);
  });
});

describe("distâncias", () => {
  it("levenshtein", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
  });
  it("melhor janela", () => {
    expect(bestWindowDistance("abc", "xxabcxx")).toBe(0);
    expect(bestWindowDistance("abd", "xxabcxx")).toBe(1);
  });
});

describe("[RF05] numbersSupported", () => {
  it("todo número da correção precisa estar nas fontes", () => {
    expect(numbersSupported("Segundo o IBGE, a desocupação em 2023 foi de 7,8%.", [SOURCE]).ok).toBe(true);
    expect(numbersSupported("A desocupação foi 7,76% em 2023", ["média de 7,8% em 2023"]).ok).toBe(true); // arredondamento
    const r = numbersSupported("A desocupação foi de 9,1% em 2023.", [SOURCE]);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toEqual(["9,1%"]);
  });

  it("ano, nº de lei e outros inteiros sem unidade: só igualdade exata (sem ±20 em ano)", () => {
    const r = numbersSupported("Segundo o IBGE, a desocupação em 2019 foi de 7,8%.", ["Taxa de desocupação 2023: 7,8%"]);
    expect(r).toEqual({ ok: false, unsupported: ["2019"] });
    expect(numbersSupported("Em 2025 a desocupação foi de 7,8%.", ["Taxa de desocupação 2023: 7,8%"]).ok).toBe(false);
    expect(numbersSupported("Criado pela Lei 12.870.", ["Lei 12.871, de 22 de outubro de 2013"]).ok).toBe(false);
    expect(numbersSupported("Criado pela Lei 12.871 em 21 de outubro.", ["Lei 12.871, de 22 de outubro de 2013"]).ok).toBe(false);
    expect(numbersSupported("Criado pela Lei 12.871 em 22 de outubro de 2013.", ["Lei 12.871, de 22 de outubro de 2013"]).ok).toBe(true);
    // medida com unidade/multiplicador continua tolerando arredondamento
    expect(numbersSupported("São cerca de 21 milhões de famílias.", ["20,8 milhões de famílias"]).ok).toBe(true);
  });

  it("unidades diferentes não casam (% ≠ p.p.)", () => {
    expect(numbersSupported("A taxa subiu 2%.", ["variação = 2 p.p."]).ok).toBe(false);
    expect(numbersSupported("A taxa subiu 2 p.p.", ["variação = 2 p.p."]).ok).toBe(true);
  });

  it("número da própria fala não sustenta a correção; só passa negado e se bater com o que foi dito", () => {
    const said = { refuted: ["o desemprego em 2023 foi de 12%"] };
    const ev = ["Taxa de desocupação 2023: 7,8%"];
    // o 12% do candidato reapresentado como dado correto
    expect(numbersSupported("Segundo o IBGE, a desocupação em 2023 foi de 12%.", ev, said)).toEqual({ ok: false, unsupported: ["12%"] });
    // negado: é o valor refutado, não o dado correto
    expect(numbersSupported("Desocupação de 2023 foi 7,8%, não 12% (IBGE).", ev, said).ok).toBe(true);
    expect(numbersSupported("A desocupação em 2023 não foi de 12%, foi 7,8%.", ev, said).ok).toBe(true);
    // negado mas não é o que foi dito
    expect(numbersSupported("Desocupação de 2023 foi 7,8%, não 15%.", ev, said).ok).toBe(false);
    // "não." encerra a frase: o número seguinte não está negado
    expect(numbersSupported("Caiu? Não. 12% em 2023.", ev, said).ok).toBe(false);
    // sem `refuted`, a fala não conta de jeito nenhum
    expect(numbersSupported("Desocupação de 2023 foi 7,8%, não 12%.", ev).ok).toBe(false);
  });
});

// Casos reais em que a trava calou alerta certo (ensaio da Band reprocessado e debate da Globo, out/2026)
describe("[RF05] trava de número: o que não é dado novo não cala o alerta", () => {
  it("número por extenso na fonte sustenta o mesmo número em dígitos (\"quatro meses\")", () => {
    const ev = ["Com isso, ao todo, o PT governará por 17 anos, quatro meses e 12 dias em um período de 24 anos"];
    const said = { refuted: ["O PT já governa esse país há 20 anos dos últimos 24."] };
    const correction = "Segundo o Estadão Verifica, o PT somou cerca de 17 anos (17 anos, 4 meses e 12 dias) na Presidência nos últimos 24 anos, não 20.";
    expect(numbersSupported(correction, ev, said)).toEqual({ ok: true, unsupported: [] });
    expect(wordNumbers("vinte e cinco obras, dois mil e quinhentos reais, mil novecentos e oitenta")).toEqual([25, 2500, 1980]);
    // artigo não é número; "mil" e "quinhentos" de um número em dígitos não viram números soltos
    expect(wordNumbers("uma obra de R$ 3 mil e quinhentos")).toEqual([]);
    expect(numbersSupported("Foi 1 obra.", ["uma obra"]).ok).toBe(false);
  });

  it("número da fala contraposto ao dado correto vale; confirmado como dado, não", () => {
    const tres = { refuted: ["nós fizemos 3 ou 4 vezes mais do que o governo dele fizeram"] };
    expect(
      numbersSupported("Investimento cresceu, mas não chegou a 3 ou 4 vezes o do governo anterior.", ["cresceram com Lula, mas não chegaram a triplicar ou quadruplicar"], tres),
    ).toEqual({ ok: true, unsupported: [] });
    const obras = ["em agosto de 2022, existiam 8.674 construções paralisadas e, em abril de 2023, 8.603 obras"];
    expect(numbersSupported("Havia 8.674 em agosto de 2022 e 8.603 em abril de 2023, mais que 6.000.", obras, { refuted: ["nós herdamos 6000 obras paradas"] }).ok).toBe(true);
    expect(numbersSupported("TCU registrou 11.469 obras paralisadas, abaixo de 11.500.", ["havia 11.469 obras paralisadas"], { refuted: ["existem mais de 11500 obras paralisadas"] }).ok).toBe(true);
    expect(numbersSupported("As evidências não mostram 20 metros.", ["de 40 metros para 30 metros"], { refuted: ["hoje tem 20"] }).ok).toBe(true);
    // contraposto, mas não foi o que o falante disse
    expect(numbersSupported("Havia 8.674, mais que 7.000.", obras, { refuted: ["nós herdamos 6000 obras paradas"] })).toEqual({ ok: false, unsupported: ["7.000"] });
    // o número do falante apresentado como certo continua sem fonte
    expect(numbersSupported("O valor de R$ 3,5 bilhões confere.", ["o governo devolveu dinheiro"], { refuted: ["já pagamos 3,5 bilhões"] }).ok).toBe(false);
  });

  it("rodovia e ato normativo valem como nome: BR-319 da fala; EC 123 = Emenda Constitucional 123", () => {
    const ev = ["as intervenções posteriores são de recuperação e reconstrução de uma estrada existente"];
    const said = { refuted: ["que liga Porto Velho a Manaus, que é a BR 319."] };
    expect(numbersSupported("A BR-319 recebe recuperação de estrada existente.", ev, said).ok).toBe(true);
    // o ano que o trecho verificado não traz continua barrando
    expect(numbersSupported("A BR-319 foi inaugurada em 1976.", ev, said)).toEqual({ ok: false, unsupported: ["1976"] });
    expect(numbersSupported("O valor veio pela EC 123, de 2022.", ["a Emenda Constitucional 123, de 14 de julho de 2022, estabeleceu"]).ok).toBe(true);
    // número de lei dito pelo falante não vale só por ter sido dito: qual lei é dado
    expect(numbersSupported("Foi a Lei 12.870.", ["programa criado em 2013"], { refuted: ["a Lei 12.870 criou o programa"] }).ok).toBe(false);
    expect(numbersSupported("Criado pela Lei 12.870.", ["Lei 12.871, de 22 de outubro de 2013"]).ok).toBe(false);
  });

  it("data comparada inteira e em qualquer formato, nunca pelos pedaços", () => {
    const viagem = ["Em 7 de maio de 2026, Lula esteve pessoalmente nos Estados Unidos", "19/10/2026"];
    expect(numbersSupported("Segundo o g1 (Fato ou Fake, 19/10/2026), Lula esteve nos EUA em 7/5/2026.", viagem).ok).toBe(true);
    expect(numbersSupported("Segundo o Poder360 (24.set.2026), o governo bloqueou bens.", ["24/09/2026"]).ok).toBe(true);
    // 10, 4 e 2026 soltos na fonte não sustentam 10/04/2026
    expect(numbersSupported("A medida saiu em 10/04/2026.", ["10 obras em 4 estados em 2026"])).toEqual({ ok: false, unsupported: ["10/04/2026"] });
    // dia e mês citados sem ano valem para a data com ano
    expect(numbersSupported("Mauro Vieira se reuniu com Rubio em 16/10/2026.", ["em 16 de outubro, Mauro Vieira"]).ok).toBe(true);
    expect(numbersSupported("Criado em 21 de outubro.", ["Lei 12.871, de 22 de outubro de 2013"]).ok).toBe(false);
    // mês/ano sem par: o ano ainda vale como número, como antes
    expect(numbersSupported("8.603 obras em abril de 2023.", ["8.603 obras em 2023"]).ok).toBe(true);
  });

  it("data de citação que não confere sai do texto; a que confere fica", () => {
    const src = ["A carga aqui está acima da média de nações da América Latina"];
    expect(dropUnverifiedCitationDates("Segundo o g1 (10/04/2026), a carga de 2025 é recorde.", src)).toBe("Segundo o g1, a carga de 2025 é recorde.");
    expect(dropUnverifiedCitationDates("Segundo o g1 (Fato ou Fake, 19/10/2026), Lula foi aos EUA.", src)).toBe("Segundo o g1 (Fato ou Fake), Lula foi aos EUA.");
    expect(dropUnverifiedCitationDates("Segundo o FBSP (2024), o medo cresceu.", ["23/10/2026"])).toBe("Segundo o FBSP, o medo cresceu.");
    // confere com a data de publicação da evidência
    for (const ok of ["Segundo a Lupa (18/10/2026), a lei prevê 20 a 40 anos.", "Segundo o FBSP/Datafolha (2026), o medo cresceu."]) {
      expect(dropUnverifiedCitationDates(ok, ["18/10/2026"])).toBe(ok);
    }
    // parêntese que não é data, ou data fora de citação: intactos
    for (const keep of ["Segundo o Tesouro (via Fato ou Fake, g1), houve superávit.", "A MP foi publicada (18/01/2019) no governo Bolsonaro."]) {
      expect(dropUnverifiedCitationDates(keep, src)).toBe(keep);
    }
  });
});
