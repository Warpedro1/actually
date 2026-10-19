import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEGMENTER_OPTIONS,
  Segmenter,
  initialSegmenterState,
  segmenterStep,
  type SegmenterEvent,
  type Word,
} from "../src/segmenter";

const w = (text: string, start: number, end: number, speaker: number | null = 0): Word => ({ text, start, end, speaker });

/** Frase com uma palavra por 0,4 s a partir de t0. */
function phrase(textWords: string[], t0: number, speaker: number | null = 0): Word[] {
  return textWords.map((t, i) => w(t, t0 + i * 0.4, t0 + i * 0.4 + 0.3, speaker));
}

function run(events: SegmenterEvent[]) {
  const s = new Segmenter();
  return events.flatMap((e) => s.push(e));
}

describe("segmentador", () => {
  it("acumula finais e emite no speech_final", () => {
    let st = initialSegmenterState();
    let r = segmenterStep(st, { type: "final", words: phrase(["O", "desemprego"], 0), speechFinal: false });
    expect(r.segments).toEqual([]);
    st = r.state;
    r = segmenterStep(st, { type: "final", words: phrase(["caiu", "pela", "metade."], 0.8), speechFinal: true });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toEqual({ text: "O desemprego caiu pela metade.", speaker_label: "S0", t_start: 0, t_end: 1.9 });
    expect(r.state.pending).toEqual([]);
  });

  it("emite no UtteranceEnd quando não veio speech_final", () => {
    const segs = run([
      { type: "final", words: phrase(["Inflação", "de", "dez", "por", "cento."], 5, 1), speechFinal: false },
      { type: "utterance_end" },
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.speaker_label).toBe("S1");
    expect(segs[0]!.t_start).toBe(5);
  });

  it("UtteranceEnd sem nada pendente não emite (já saiu no speech_final)", () => {
    const segs = run([
      { type: "final", words: phrase(["Boa", "noite."], 0), speechFinal: true },
      { type: "utterance_end" },
    ]);
    expect(segs).toHaveLength(1);
  });

  it("corta na troca estável de speaker dominante", () => {
    const a = phrase(["Eu", "reduzi", "o", "desmatamento", "em", "metade."], 0, 0);
    const b = phrase(["Isso", "não", "é", "verdade."], 2.4, 1);
    const segs = run([{ type: "final", words: [...a, ...b], speechFinal: true }]);
    expect(segs.map((s) => s.speaker_label)).toEqual(["S0", "S1"]);
    expect(segs[0]!.text).toBe("Eu reduzi o desmatamento em metade.");
    expect(segs[1]!.text).toBe("Isso não é verdade.");
    expect(segs[1]!.t_start).toBe(2.4);
  });

  it("corta a troca de speaker sem esperar o speech_final (fala atravessada)", () => {
    const a = phrase(["Eu", "reduzi", "o", "desmatamento."], 0, 0);
    const b = phrase(["Mentira", "isso", "aí"], 1.6, 1);
    const r = segmenterStep(initialSegmenterState(), { type: "final", words: [...a, ...b], speechFinal: false });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.speaker_label).toBe("S0");
    expect(r.state.pending.map((x) => x.text)).toEqual(["Mentira", "isso", "aí"]);
  });

  it("não corta por 1–2 palavras de outro speaker (oscilação da diarização)", () => {
    const words = [
      ...phrase(["O", "salário", "mínimo"], 0, 0),
      ...phrase(["subiu"], 1.2, 1),
      ...phrase(["acima", "da", "inflação."], 1.6, 0),
    ];
    const segs = run([{ type: "final", words, speechFinal: true }]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("O salário mínimo subiu acima da inflação.");
    expect(segs[0]!.speaker_label).toBe("S0");
  });

  it("palavras sem speaker: speaker_label null e sem cortes", () => {
    const segs = run([{ type: "final", words: phrase(["Sem", "diarização", "aqui."], 0, null), speechFinal: true }]);
    expect(segs).toEqual([{ text: "Sem diarização aqui.", speaker_label: null, t_start: 0, t_end: 1.1 }]);
  });

  it("palavras sem speaker no meio não quebram a sequência", () => {
    const words = [...phrase(["Primeiro", "ponto"], 0, 0), w("é", 0.8, 0.9, null), ...phrase(["claro."], 1.0, 0)];
    const segs = run([{ type: "final", words, speechFinal: true }]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.speaker_label).toBe("S0");
  });

  it("corta fala contínua longa em fim de frase", () => {
    // 70 palavras × 0,4 s = 28 s; uma frase termina por volta de 12 s
    const texts = Array.from({ length: 70 }, (_, i) => (i === 29 ? "governo." : `p${i}`));
    const r = segmenterStep(initialSegmenterState(), { type: "final", words: phrase(texts, 0), speechFinal: false });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.text.endsWith("governo.")).toBe(true);
    expect(r.segments[0]!.t_end).toBeLessThanOrEqual(DEFAULT_SEGMENTER_OPTIONS.maxSegmentS);
    expect(r.state.pending[0]!.text).toBe("p30");
  });

  it("sem fim de frase, corta na maior pausa dentro da janela", () => {
    const first = phrase(Array.from({ length: 30 }, (_, i) => `a${i}`), 0); // até ~11,9 s
    const second = phrase(Array.from({ length: 40 }, (_, i) => `b${i}`), 13); // pausa de ~1,1 s; vai até ~28,9 s
    const r = segmenterStep(initialSegmenterState(), { type: "final", words: [...first, ...second], speechFinal: false });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.text.split(" ").at(-1)).toBe("a29");
    expect(r.state.pending[0]!.text).toBe("b0");
  });

  it("descarta palavras repetidas após reconexão (reenvio de áudio)", () => {
    const s = new Segmenter();
    s.push({ type: "final", words: phrase(["Eu", "disse", "isso"], 0), speechFinal: false });
    // reconexão reenviou o áudio a partir de ~0,8 s: "isso" volta + palavras novas
    const segs = s.push({
      type: "final",
      words: [w("isso", 0.8, 1.1), w("ontem.", 1.2, 1.5)],
      speechFinal: true,
    });
    expect(segs.map((x) => x.text)).toEqual(["Eu disse isso ontem."]);
  });

  it("flush emite o pendente no encerramento", () => {
    const segs = run([{ type: "final", words: phrase(["Última", "frase"], 0), speechFinal: false }, { type: "flush" }]);
    expect(segs.map((x) => x.text)).toEqual(["Última frase"]);
  });

  it("ignora palavras vazias e speech_final sem palavras", () => {
    const segs = run([{ type: "final", words: [w(" ", 0, 0.1)], speechFinal: true }]);
    expect(segs).toEqual([]);
  });
});
