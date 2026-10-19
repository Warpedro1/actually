// Chunking por sentenças: ~800 tokens por chunk com ~100 de sobreposição.
// Cada chunk é um trecho LITERAL do texto (slice do original), para que a
// verificação de citação do pipeline encontre o trecho exatamente como foi guardado.
import { estimateTokens, splitSentences, type Span } from "./text";

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

export interface Chunk {
  index: number;
  text: string;
  start: number;
  end: number;
}

/** Sentença maior que o limite é quebrada em pedaços por fronteira de palavra. */
function splitLong(text: string, span: Span, maxTokens: number): Span[] {
  const maxChars = Math.floor(maxTokens * 3.6);
  const out: Span[] = [];
  let s = span.start;
  while (s < span.end) {
    let e = Math.min(span.end, s + maxChars);
    if (e < span.end) {
      const cut = text.lastIndexOf(" ", e);
      if (cut > s + maxChars / 2) e = cut;
    }
    out.push({ start: s, end: e });
    s = e;
    while (s < span.end && /\s/.test(text[s]!)) s++;
  }
  return out;
}

export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? 800;
  const overlapTokens = opts.overlapTokens ?? 100;
  const units = splitSentences(text).flatMap((sp) =>
    estimateTokens(text.slice(sp.start, sp.end)) > maxTokens ? splitLong(text, sp, maxTokens) : [sp],
  );
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < units.length) {
    let j = i;
    let tokens = 0;
    while (j < units.length) {
      const t = estimateTokens(text.slice(units[j]!.start, units[j]!.end));
      if (j > i && tokens + t > maxTokens) break;
      tokens += t;
      j++;
    }
    const start = units[i]!.start;
    const end = units[j - 1]!.end;
    chunks.push({ index: chunks.length, text: text.slice(start, end), start, end });
    if (j >= units.length) break;
    // volta sentenças inteiras até cobrir ~overlapTokens, sem deixar de avançar
    let k = j;
    let ov = 0;
    while (k - 1 > i) {
      const t = estimateTokens(text.slice(units[k - 1]!.start, units[k - 1]!.end));
      if (ov + t > overlapTokens) break;
      ov += t;
      k--;
    }
    i = k;
  }
  return chunks;
}
