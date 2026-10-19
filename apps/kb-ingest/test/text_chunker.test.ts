import { describe, expect, it } from "vitest";
import { chunkText } from "../src/lib/chunker";
import { estimateTokens, normalizeForMatch, splitSentences } from "../src/lib/text";
import { planBatches } from "../src/lib/embed";

const sentences = (t: string) => splitSentences(t).map((s) => t.slice(s.start, s.end));

describe("splitSentences", () => {
  it("quebra em pontuação seguida de maiúscula e em linhas", () => {
    expect(sentences("Primeira frase. Segunda frase! Terceira?\nQuarta linha")).toEqual([
      "Primeira frase.",
      "Segunda frase!",
      "Terceira?",
      "Quarta linha",
    ]);
  });
  it("não quebra em abreviação, decimal, domínio nem iniciais", () => {
    const t = "O Sr. Beltrano disse que a taxa foi de 6.5% em 2023. Veja gov.br para mais. J. Silva confirmou.";
    expect(sentences(t)).toEqual([
      "O Sr. Beltrano disse que a taxa foi de 6.5% em 2023.",
      "Veja gov.br para mais.",
      "J. Silva confirmou.",
    ]);
  });
  it("mantém aspas de fechamento na frase", () => {
    expect(sentences("Ele disse: “é mentira.” Depois saiu.")).toEqual(["Ele disse: “é mentira.”", "Depois saiu."]);
  });
  it("posições são literais", () => {
    const t = "  Um.  Dois.\n\nTrês. ";
    for (const s of splitSentences(t)) expect(t.slice(s.start, s.end).trim()).toBe(t.slice(s.start, s.end));
  });
});

describe("chunkText", () => {
  const para = (i: number) =>
    `Frase número ${i} sobre o orçamento federal e seus efeitos na economia brasileira, com detalhes adicionais para dar corpo.`;
  const text = Array.from({ length: 200 }, (_, i) => para(i)).join(" ");

  it("cada chunk é trecho literal do texto e respeita o limite", () => {
    const chunks = chunkText(text, { maxTokens: 800, overlapTokens: 100 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(text.slice(c.start, c.end)).toBe(c.text);
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(800);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("chunks consecutivos se sobrepõem (~100 tokens) e cobrem o texto todo", () => {
    const chunks = chunkText(text, { maxTokens: 800, overlapTokens: 100 });
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(text.length);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBeLessThan(chunks[i - 1]!.end); // sobreposição
      expect(chunks[i]!.start).toBeGreaterThan(chunks[i - 1]!.start); // avança
      const overlap = text.slice(chunks[i]!.start, chunks[i - 1]!.end);
      expect(estimateTokens(overlap)).toBeLessThanOrEqual(110);
    }
  });

  it("sentença gigante é quebrada por palavras", () => {
    const long = Array.from({ length: 2000 }, (_, i) => `palavra${i}`).join(" ");
    const chunks = chunkText(long, { maxTokens: 300, overlapTokens: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(300);
      expect(long.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it("texto curto vira um chunk só", () => {
    expect(chunkText("Só isso.")).toEqual([{ index: 0, text: "Só isso.", start: 0, end: 8 }]);
  });
});

describe("normalizeForMatch / planBatches", () => {
  it("remove acento, caixa e espaços extras", () => {
    expect(normalizeForMatch("  Desocupação   É  ALTA ")).toBe("desocupacao e alta");
  });
  it("lotes respeitam quantidade e tokens", () => {
    const texts = Array.from({ length: 150 }, () => "x".repeat(3600)); // ~1000 tokens cada
    const b = planBatches(texts, 64, 60_000);
    expect(b.flat()).toEqual(texts.map((_, i) => i));
    for (const batch of b) expect(batch.length).toBeLessThanOrEqual(60);
  });
});
