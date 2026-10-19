import { describe, expect, it } from "vitest";
import {
  canonicalUnit, claimHash, extractNumbers, normalizeClaimNumbers, normalizeText, numberSignature,
  parseNumericLiteral, parsePtBrNumber, polaritySignature, sameFacts,
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
    expect(sameFacts({ text_normalized: "Foram criados 1,5 milhão de empregos em 2023", indicator: ind }, { text_normalized: "Em 2023 foram criados 1.500.000 empregos", indicator: ind })).toBe(true);
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
