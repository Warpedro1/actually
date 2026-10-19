import { describe, expect, it } from "vitest";
import { prefilter } from "../src/prefilter";

describe("prefilter (conservador)", () => {
  it.each([
    ["", "vazio"],
    ["Obrigado.", "curto"],
    ["Boa noite a todos, obrigado.", "so_cortesia"],
    ["Candidato Lula, o senhor tem a palavra.", "moderacao"],
    ["Vamos ao próximo bloco do debate.", "moderacao"],
    ["Tempo esgotado, candidato.", "moderacao"],
    ["E o senhor, vai fazer o quê? Vai explicar isso?", "so_pergunta"],
  ])("descarta %j (%s)", (text, reason) => {
    expect(prefilter(text)).toEqual({ pass: false, reason });
  });

  it.each([
    "Eu criei o Pix.",
    "Gerei 10 milhões.",
    "Boa noite. No meu governo o desemprego caiu para 6,6%.",
    "Ele votou contra a PEC da Transição no Senado.",
    "Quem criou o Bolsa Família? Fui eu, em 2003.",
    "O desmatamento caiu muito.",
  ])("deixa passar %j", (text) => {
    expect(prefilter(text).pass).toBe(true);
  });
});
