import { describe, expect, it } from "vitest";
import { bestWindowDistance, levenshtein, normalizeForQuote, numbersSupported, quoteCheck } from "../src/quoteCheck";

const SOURCE = `A taxa de desocupação no Brasil ficou em 7,8% na média de 2023, segundo a PNAD Contínua divulgada pelo IBGE.
O número de pessoas desocupadas recuou para 8,5 milhões — o menor contingente desde 2015.
"É um resultado consistente", disse a coordenadora da pesquisa.`;

describe("normalizeForQuote", () => {
  it("unifica aspas, travessões, acentos e espaços", () => {
    expect(normalizeForQuote("“É  um” resultado — ok…")).toBe('"e um" resultado - ok...');
  });
});

describe("quoteCheck", () => {
  it("substring exata após normalização", () => {
    const r = quoteCheck("a taxa de desocupacao no brasil ficou em 7,8% na media de 2023", SOURCE);
    expect(r).toMatchObject({ verified: true, method: "exact", similarity: 1 });
  });

  it("aceita aspas tipográficas trocadas e travessão diferente", () => {
    expect(quoteCheck("desocupadas recuou para 8,5 milhões - o menor contingente desde 2015", SOURCE).verified).toBe(true);
    expect(quoteCheck("\"É um resultado consistente\", disse a coordenadora", SOURCE).verified).toBe(true);
  });

  it("aceita pequena diferença de transcrição (fuzzy ≥ 0,9)", () => {
    const r = quoteCheck("A taxa de desocupaçao no Brasil ficou em 7,8% na média do 2023", SOURCE);
    expect(r.verified).toBe(true);
    expect(r.method).toBe("fuzzy");
    expect(r.similarity).toBeGreaterThanOrEqual(0.9);
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

  it("elipse: partes precisam existir em ordem", () => {
    expect(quoteCheck("A taxa de desocupação no Brasil [...] segundo a PNAD Contínua divulgada pelo IBGE", SOURCE).verified).toBe(true);
    expect(quoteCheck("segundo a PNAD Contínua divulgada pelo IBGE ... A taxa de desocupação no Brasil", SOURCE).verified).toBe(false);
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

describe("numbersSupported", () => {
  it("todo número da correção precisa estar nas fontes", () => {
    expect(numbersSupported("Segundo o IBGE, a desocupação em 2023 foi de 7,8%.", [SOURCE]).ok).toBe(true);
    expect(numbersSupported("A desocupação foi 7,76% em 2023", ["média de 7,8% em 2023"]).ok).toBe(true); // arredondamento
    const r = numbersSupported("A desocupação foi de 9,1% em 2023.", [SOURCE]);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toEqual(["9,1%"]);
  });
});
