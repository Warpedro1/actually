import { describe, expect, it } from "vitest";
import { chunkText } from "../src/lib/chunker";
import { estimateTokens, normalizeForMatch, splitSentences, stripRelatedLinks } from "../src/lib/text";
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

// Estrutura das páginas reais (Poder360, STF, TSE, Agência Brasil); nomes e fatos fictícios.
describe("[RF15] [RF05] stripRelatedLinks: manchetes de outras matérias não ficam no texto citável", () => {
  it("lista datada depois de \"Leia mais:\" sai inteira; o parágrafo anterior fica", () => {
    const t = [
      "O ministro Fulano determinou o cumprimento da pena. Leia a íntegra da decisão.",
      "",
      "(Redação//CF)",
      "",
      "Leia mais:",
      "",
      "7/11/2030 – Turma rejeita recursos de ex-governador na AP 9999",
      "",
      "11/9/2030 – STF condena os oito réus do núcleo 1",
    ].join("\n");
    expect(stripRelatedLinks(t)).toBe(
      "O ministro Fulano determinou o cumprimento da pena. Leia a íntegra da decisão.\n\n(Redação//CF)",
    );
  });

  it("\"Leia mais sobre ...\" com manchetes sem data sai até o próximo parágrafo, que fica", () => {
    const t = [
      "O candidato Beltrano respondeu às críticas.",
      "Leia mais sobre o debate da TV Exemplo:",
      "Beltrano diz que Sicrano mente sobre a ponte",
      "4.dez.2030 – Sicrano cita áudio sobre R$ 30 milhões",
      "Pesquisas mostram empate técnico entre os dois",
      "O debate durou duas horas e teve quatro blocos.",
    ].join("\n");
    expect(stripRelatedLinks(t)).toBe("O candidato Beltrano respondeu às críticas.\nO debate durou duas horas e teve quatro blocos.");
  });

  it("\"Leia mais: <manchete>\" no meio do texto sai sozinho; o intertítulo seguinte fica", () => {
    const t = [
      "\u201cNão há prova\u201d, finalizou o relator.",
      "",
      "Leia mais: Com o placar de 3 a 1, tribunal suspende julgamento",
      "",
      "Ministra Fulana",
      "",
      "Ao votar com o relator, a ministra Fulana afirmou que a reunião foi um monólogo.",
    ].join("\n");
    expect(stripRelatedLinks(t)).toBe(
      "\u201cNão há prova\u201d, finalizou o relator.\n\nMinistra Fulana\n\nAo votar com o relator, a ministra Fulana afirmou que a reunião foi um monólogo.",
    );
  });

  it("ruído de página sai; frase longa que começa com \"Veja também\" fica", () => {
    const longa = "Veja também que o orçamento da obra, segundo o relatório do tribunal de contas, passou de R$ 2 bilhões para R$ 3 bilhões entre 2028 e 2030, com aditivos assinados sem licitação e sem parecer da procuradoria do estado.";
    const t = ["publicidade", "Primeiro parágrafo da matéria.", "PUBLICIDADE", ">> Siga o canal da Agência Exemplo no WhatsApp", longa].join("\n");
    expect(stripRelatedLinks(t)).toBe(`Primeiro parágrafo da matéria.\n${longa}`);
  });

  it("manchete que termina em aspas continua na lista (não interrompe o corte)", () => {
    const t = [
      "Leia mais sobre o debate da TV Exemplo:",
      "Beltrano pede voto: \u201cSou melhor que ele\u201d",
      "Sicrano diz que Beltrano mente e é \u201cmalandro\u201d na \u201cTV Exemplo\u201d",
      "Beltrano cobra Sicrano por caso da ponte",
      "O debate terminou às 23h.",
    ].join("\n");
    expect(stripRelatedLinks(t)).toBe("O debate terminou às 23h.");
  });

  it("lista datada termina na primeira linha sem data, mesmo com \"publicidade\" no meio (o título seguinte fica)", () => {
    const t = [
      "Leia mais:",
      "4.dez.2030 – Fulano recebeu mesada, diz testemunha",
      "6.mar.2031 – Fulano movimentou R$ 9 milhões",
      "publicidade",
      "publicidade",
      "CORREÇÃO",
      "21.out.2031 (10h) – diferentemente do publicado, o pedido foi feito em março.",
    ].join("\n");
    expect(stripRelatedLinks(t)).toBe("CORREÇÃO\n21.out.2031 (10h) – diferentemente do publicado, o pedido foi feito em março.");
  });

  it("\"Leia mais\" solto (sem dois-pontos, chamada não capturada) sai sozinho; o intertítulo seguinte fica", () => {
    const t = ["Primeiro parágrafo.", "Leia mais", "Contradições sobre a eleição", "Segundo parágrafo."].join("\n");
    expect(stripRelatedLinks(t)).toBe("Primeiro parágrafo.\nContradições sobre a eleição\nSegundo parágrafo.");
  });

  it("\"Saiba mais no ...\" é linha única: não leva a linha seguinte junto", () => {
    expect(stripRelatedLinks("Fim da matéria.\nSaiba mais no Jornal Exemplo, da TV Exemplo\nNota da redação")).toBe(
      "Fim da matéria.\nNota da redação",
    );
  });
});
