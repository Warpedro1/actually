// Segmentador: transforma resultados finais do Deepgram em segmentos para a API.
//
// Função pura (estado entra, estado + segmentos saem) para ser testável sem rede
// e sem relógio. Todos os tempos aqui são da *linha do tempo da captura*
// (segundos desde o início), já corrigidos pelo offset de cada conexão WS.

/** Palavra final, já na linha do tempo da captura. */
export interface Word {
  /** Texto com pontuação/capitalização (punctuated_word quando houver). */
  text: string;
  start: number;
  end: number;
  /**
   * Rótulo do speaker da diarização, já qualificado pela sessão do STT (ex.:
   * "s3-a1b2c3:S0"; veja speakerLabel em deepgram.ts) — o mesmo número em
   * sessões diferentes é speaker diferente. null quando o Deepgram não informou.
   */
  speaker: string | null;
}

export type SegmenterEvent =
  /** Resultado com is_final=true. speechFinal = endpointing detectou fim de fala. */
  | { type: "final"; words: Word[]; speechFinal: boolean }
  /** Mensagem UtteranceEnd (silêncio ≥ utterance_end_ms após a última palavra). */
  | { type: "utterance_end" }
  /** Encerramento: emite o que estiver pendente. */
  | { type: "flush" };

export interface SegmentDraft {
  text: string;
  speaker_label: string | null;
  t_start: number;
  t_end: number;
}

export interface SegmenterState {
  pending: Word[];
  /** Fim da última palavra aceita — descarta repetição após reconexão do WS. */
  lastWordEnd: number;
}

export interface SegmenterOptions {
  /** Fala contínua máxima antes de cortar (s). */
  maxSegmentS: number;
  /** Ao cortar por tamanho, só aceita fim de frase se o pedaço tiver pelo menos isso (s). */
  minCutS: number;
  /** Palavras seguidas de outro speaker para considerar troca (evita "piscar" da diarização). */
  minSpeakerRunWords: number;
  /** Tolerância ao comparar com lastWordEnd (s). */
  overlapEpsilon: number;
}

export const DEFAULT_SEGMENTER_OPTIONS: SegmenterOptions = {
  maxSegmentS: 25,
  minCutS: 8,
  minSpeakerRunWords: 3,
  overlapEpsilon: 0.05,
};

export function initialSegmenterState(): SegmenterState {
  return { pending: [], lastWordEnd: -Infinity };
}

export interface StepResult {
  state: SegmenterState;
  segments: SegmentDraft[];
}

export function segmenterStep(
  state: SegmenterState,
  event: SegmenterEvent,
  opts: SegmenterOptions = DEFAULT_SEGMENTER_OPTIONS,
): StepResult {
  if (event.type === "utterance_end" || event.type === "flush") {
    return emitAll(state, opts);
  }

  // Após reconexão o áudio é reenviado a partir do último final; palavras que
  // começam antes do que já aceitamos são repetição e ficam de fora.
  let lastWordEnd = state.lastWordEnd;
  const fresh: Word[] = [];
  for (const w of event.words) {
    if (!w.text.trim()) continue;
    if (w.start < lastWordEnd - opts.overlapEpsilon) continue;
    fresh.push(w);
    lastWordEnd = Math.max(lastWordEnd, w.end);
  }

  // Cortes "no meio": troca estável de speaker, fim de frase depois de minCutS
  // (só se a fala continua pendente; no speech_final o emitAll já leva tudo) e
  // fala longa demais.
  const { pending, segments } = drainCuts([...state.pending, ...fresh], opts, !event.speechFinal);
  const next: SegmenterState = { pending, lastWordEnd };
  if (event.speechFinal) {
    const flushed = emitAll(next, opts);
    return { state: flushed.state, segments: [...segments, ...flushed.segments] };
  }
  return { state: next, segments };
}

/** Emite tudo que está pendente, ainda respeitando trocas de speaker já estáveis. */
function emitAll(state: SegmenterState, opts: SegmenterOptions): StepResult {
  const { pending, segments } = drainCuts(state.pending, opts);
  if (pending.length > 0) segments.push(toDraft(pending));
  return { state: { pending: [], lastWordEnd: state.lastWordEnd }, segments };
}

function drainCuts(
  words: Word[],
  opts: SegmenterOptions,
  eager = false,
): { pending: Word[]; segments: SegmentDraft[] } {
  let pending = words;
  const segments: SegmentDraft[] = [];
  for (;;) {
    const cut = speakerCut(pending, opts) ?? (eager ? sentenceCut(pending, opts) : null) ?? lengthCut(pending, opts);
    if (cut === null) break;
    segments.push(toDraft(pending.slice(0, cut)));
    pending = pending.slice(cut);
  }
  return { pending, segments };
}

/**
 * Índice onde começa uma sequência estável (≥ minSpeakerRunWords) de outro
 * speaker, diferente do dominante do que veio antes. Palavras sem speaker não
 * quebram nem formam sequência. Retorna null se não há troca.
 */
function speakerCut(words: Word[], opts: SegmenterOptions): number | null {
  let i = 0;
  while (i < words.length) {
    const sp = words[i]!.speaker;
    if (sp === null) {
      i++;
      continue;
    }
    // tamanho da sequência de `sp` a partir de i (ignorando palavras sem speaker no meio)
    let run = 0;
    let j = i;
    while (j < words.length && (words[j]!.speaker === sp || words[j]!.speaker === null)) {
      if (words[j]!.speaker === sp) run++;
      j++;
    }
    if (i > 0 && run >= opts.minSpeakerRunWords) {
      const before = dominantSpeaker(words.slice(0, i));
      if (before !== null && before !== sp) return i;
    }
    i = j;
  }
  return null;
}

const SENTENCE_END_RE = /[.!?…]["”')\]]*$/;

/**
 * Corte em fim de frase sem esperar a janela fechar: com pelo menos minCutS de
 * fala desde o início do pendente, o último fim de frase já finalizado (dentro
 * de maxSegmentS) fecha o segmento agora, e o resto continua pendente. Sem
 * isto, o corte por tamanho só olhava para trás quando a fala chegava a
 * maxSegmentS: um pedaço de 8 s saía ~17 s depois de terminar (ensaios de
 * 21/10, monólogos: p95 fim da fala → recebido de 14,5 s).
 */
function sentenceCut(words: Word[], opts: SegmenterOptions): number | null {
  if (words.length === 0) return null;
  const t0 = words[0]!.start;
  for (let k = words.length - 1; k >= 0; k--) {
    const w = words[k]!;
    if (w.end - t0 < opts.minCutS) break;
    if (w.end - t0 <= opts.maxSegmentS && SENTENCE_END_RE.test(w.text)) return k + 1;
  }
  return null;
}

/**
 * Corte por fala contínua longa: prefere o último fim de frase que deixe um
 * pedaço ≥ minCutS; senão a maior pausa entre palavras; senão corta tudo.
 */
function lengthCut(words: Word[], opts: SegmenterOptions): number | null {
  if (words.length < 2) return null;
  const t0 = words[0]!.start;
  if (words[words.length - 1]!.end - t0 < opts.maxSegmentS) return null;

  // só considera cortes dentro da janela máxima
  let limit = 0;
  while (limit < words.length && words[limit]!.end - t0 <= opts.maxSegmentS) limit++;
  limit = Math.max(1, limit);

  for (let k = limit - 1; k >= 0; k--) {
    const w = words[k]!;
    if (w.end - t0 < opts.minCutS) break;
    if (SENTENCE_END_RE.test(w.text)) return k + 1;
  }
  let best = -1;
  let bestGap = -1;
  for (let k = 0; k < limit - 1; k++) {
    const gap = words[k + 1]!.start - words[k]!.end;
    if (words[k]!.end - t0 >= opts.minCutS && gap > bestGap) {
      bestGap = gap;
      best = k + 1;
    }
  }
  if (best > 0) return best;
  return limit;
}

export function dominantSpeaker(words: Word[]): string | null {
  const dur = new Map<string, number>();
  for (const w of words) {
    if (w.speaker === null) continue;
    // duração mínima para palavras com timestamps colados
    dur.set(w.speaker, (dur.get(w.speaker) ?? 0) + Math.max(w.end - w.start, 0.01));
  }
  let best: string | null = null;
  let bestDur = -1;
  for (const [sp, d] of dur) {
    if (d > bestDur) {
      best = sp;
      bestDur = d;
    }
  }
  return best;
}

function toDraft(words: Word[]): SegmentDraft {
  const sp = dominantSpeaker(words);
  return {
    text: words.map((w) => w.text.trim()).join(" ").slice(0, 4000),
    speaker_label: sp,
    t_start: round3(words[0]!.start),
    t_end: round3(words[words.length - 1]!.end),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Envoltório com estado para o runtime; a lógica fica toda em segmenterStep. */
export class Segmenter {
  private state = initialSegmenterState();
  constructor(private readonly opts: SegmenterOptions = DEFAULT_SEGMENTER_OPTIONS) {}

  push(event: SegmenterEvent): SegmentDraft[] {
    const r = segmenterStep(this.state, event, this.opts);
    this.state = r.state;
    return r.segments;
  }

  get pendingWords(): number {
    return this.state.pending.length;
  }
}
