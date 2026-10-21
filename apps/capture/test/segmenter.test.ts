import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEGMENTER_OPTIONS,
  Segmenter,
  initialSegmenterState,
  segmenterStep,
  type SegmenterEvent,
  type Word,
} from "../src/segmenter";

/** Speaker: número vira o rótulo curto "S<n>"; string é o rótulo completo (com sessão do STT). */
type Sp = number | string | null;
const label = (sp: Sp): string | null => (typeof sp === "number" ? `S${sp}` : sp);
const w = (text: string, start: number, end: number, speaker: Sp = 0): Word => ({ text, start, end, speaker: label(speaker) });

/** Frase com uma palavra por 0,4 s a partir de t0. */
function phrase(textWords: string[], t0: number, speaker: Sp = 0): Word[] {
  return textWords.map((t, i) => w(t, t0 + i * 0.4, t0 + i * 0.4 + 0.3, speaker));
}

function run(events: SegmenterEvent[]) {
  const s = new Segmenter();
  return events.flatMap((e) => s.push(e));
}

describe("[RF01] [RNF09] segmentador", () => {
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

describe("[RF09] speaker_label carrega a sessão do STT", () => {
  it("o rótulo do segmento é o da sessão (nunca o número cru)", () => {
    const segs = run([{ type: "final", words: phrase(["Boa", "noite."], 0, "s3-a1b2c3:S0"), speechFinal: true }]);
    expect(segs.map((s) => s.speaker_label)).toEqual(["s3-a1b2c3:S0"]);
  });

  it("mesmo número em sessões diferentes (reconexão) é outro speaker: corta e não herda o rótulo", () => {
    // fala atravessa uma reconexão: o Deepgram renumera e o novo "S0" pode ser outro candidato
    const antes = phrase(["Eu", "reduzi", "o", "desemprego."], 0, "s1-a1b2c3:S0");
    const depois = phrase(["Isso", "não", "é", "verdade."], 2, "s2-a1b2c3:S0");
    const segs = run([
      { type: "final", words: antes, speechFinal: false },
      { type: "final", words: depois, speechFinal: true },
    ]);
    expect(segs.map((s) => [s.speaker_label, s.text])).toEqual([
      ["s1-a1b2c3:S0", "Eu reduzi o desemprego."],
      ["s2-a1b2c3:S0", "Isso não é verdade."],
    ]);
  });
});

// Ensaios de 21/10: no monólogo, o corte por tamanho só olhava para trás quando a fala
// chegava a 25 s — um pedaço de 8 s saía ~17 s depois de terminar. Agora o fim de frase
// com ≥ minCutS de fala fecha o segmento no mesmo final que traz o ponto.
describe("[RNF01] segmentador: monólogo não espera a janela de 25 s", () => {
  type Timed = { at: number; ev: SegmenterEvent };

  /** Palavras de a até b (a última termina em b), ~0,4 s cada; ponto na palavra mais perto de cada instante. */
  function span(a: number, b: number, tag: string, sentenceEndsAt: number[], speaker: Sp = "s1-x:S2"): Word[] {
    const n = Math.max(2, Math.round((b - a) / 0.4));
    const step = (b - a - 0.3) / (n - 1);
    const out = Array.from({ length: n }, (_, i) => {
      const start = a + i * step;
      return w(`${tag}${i}`, start, i === n - 1 ? b : start + 0.3, speaker);
    });
    for (const t of sentenceEndsAt) {
      let best = 0;
      for (let i = 1; i < out.length; i++) if (Math.abs(out[i]!.end - t) < Math.abs(out[best]!.end - t)) best = i;
      out[best]!.text += ".";
    }
    return out;
  }

  /** Finais como o Deepgram manda em fala contínua: um a cada 3 s de áudio, 0,7 s depois; speech_final nas pausas. */
  function deepgramFinals(all: Word[], speechFinalAt: number[], chunkS = 3, lagS = 0.7): Timed[] {
    const out: Timed[] = [];
    let buf: Word[] = [];
    let chunkEnd = all[0]!.start + chunkS;
    for (const x of all) {
      while (x.end > chunkEnd) {
        if (buf.length) out.push({ at: chunkEnd + lagS, ev: { type: "final", words: buf, speechFinal: false } });
        buf = [];
        chunkEnd += chunkS;
      }
      buf.push(x);
      if (speechFinalAt.some((t) => Math.abs(t - x.end) < 1e-6)) {
        out.push({ at: x.end + lagS, ev: { type: "final", words: buf, speechFinal: true } });
        buf = [];
        chunkEnd = x.end + chunkS;
      }
    }
    if (buf.length) out.push({ at: chunkEnd + lagS, ev: { type: "final", words: buf, speechFinal: false } });
    return out;
  }

  function simulate(events: Timed[]) {
    const s = new Segmenter();
    const out = events.flatMap(({ at, ev }) => s.push(ev).map((d) => ({ ...d, delay: at - d.t_end })));
    return [...out, ...s.push({ type: "flush" }).map((d) => ({ ...d, delay: Infinity }))];
  }

  // monólogo do ensaio 2 (seq 12–16): speech_final só em 201,31 e no fim do turno
  const MONOLOGO = [
    ...span(187.8, 201.31, "a", [192.5, 197.0, 201.31]),
    ...span(201.96, 210.01, "b", [210.01]),
    ...span(210.9, 234.22, "c", [234.22]),
    ...span(234.3, 254.72, "d", [244.4, 254.72]),
    ...span(254.8, 267.54, "e", [261.2, 267.54]),
  ];

  it("fim de frase depois de 8 s sai no mesmo final; o resto fica pendente", () => {
    const texts = Array.from({ length: 30 }, (_, i) => (i === 24 ? "governo." : `p${i}`)); // ponto em ~9,9 s
    const r = segmenterStep(initialSegmenterState(), { type: "final", words: phrase(texts, 0), speechFinal: false });
    expect(r.segments.map((s) => s.text.split(" ").at(-1))).toEqual(["governo."]);
    expect(r.state.pending.map((x) => x.text)).toEqual(["p25", "p26", "p27", "p28", "p29"]);
  });

  it("fim de frase antes de 8 s não corta", () => {
    const texts = Array.from({ length: 30 }, (_, i) => (i === 10 ? "governo." : `p${i}`)); // ponto em ~4,3 s
    const r = segmenterStep(initialSegmenterState(), { type: "final", words: phrase(texts, 0), speechFinal: false });
    expect(r.segments).toEqual([]);
    expect(r.state.pending).toHaveLength(30);
  });

  it("speech_final com ponto no meio do final: um segmento só (como antes)", () => {
    const ws = [...span(0, 6, "a", []), ...span(6.3, 10, "b", [9.2])];
    const segs = run([
      { type: "final", words: ws.filter((x) => x.end <= 6), speechFinal: false },
      { type: "final", words: ws.filter((x) => x.end > 6), speechFinal: true },
    ]);
    expect(segs).toHaveLength(1);
  });

  it("rajada após reconexão (40 s num final só): segmentos ≤ 25 s, cortados em frase", () => {
    const segs = run([{ type: "final", words: span(0, 40, "r", [10, 20, 30, 38]), speechFinal: false }, { type: "flush" }]);
    for (const s of segs) expect(s.t_end - s.t_start).toBeLessThanOrEqual(DEFAULT_SEGMENTER_OPTIONS.maxSegmentS);
    expect(segs.slice(0, -1).every((s) => s.text.endsWith("."))).toBe(true);
  });

  it("monólogo do ensaio 2: nenhum segmento espera mais que um final do Deepgram (≤ 3,7 s)", () => {
    const segs = simulate(deepgramFinals(MONOLOGO, [201.31, 267.54]));
    const b = segs.find((s) => Math.abs(s.t_start - 201.96) < 0.01)!;
    expect(b.t_end).toBeCloseTo(210.01, 2); // antes saía ~17,5 s depois
    expect(Math.max(...segs.map((s) => s.delay))).toBeLessThanOrEqual(3.7);
    for (const s of segs) {
      expect(s.t_end - s.t_start).toBeLessThanOrEqual(DEFAULT_SEGMENTER_OPTIONS.maxSegmentS);
      if (s.t_end !== 201.31 && s.t_end !== 267.54) {
        expect(s.text.endsWith(".")).toBe(true);
        expect(s.t_end - s.t_start).toBeGreaterThanOrEqual(DEFAULT_SEGMENTER_OPTIONS.minCutS);
      }
    }
  });

  it("não perde nem duplica palavra", () => {
    const segs = simulate(deepgramFinals(MONOLOGO, [201.31, 267.54]));
    expect(segs.map((s) => s.text).join(" ")).toBe(MONOLOGO.map((x) => x.text).join(" "));
  });
});
