// Escolha do `quote`: o trecho LITERAL da checagem que sustenta o veredito.
// Tem de existir exatamente no `body` guardado — a verificação de citação do
// pipeline compara o que o modelo citar com este texto.
import { contentWords, normalizeForMatch, splitSentences } from "../lib/text";
import { normalizeRating } from "./rating";

const VERDICT_CUES = [
  "e falso", "e falsa", "e enganoso", "e enganosa", "nao e verdade", "nao procede", "na verdade",
  "ao contrario", "nao ha registro", "nao ha evidencia", "nao ha provas", "sem provas", "e exagerado",
  "e verdadeiro", "esta correto", "esta errado", "distorce", "engana", "de acordo com", "segundo dados",
  "segundo o", "segundo a", "dados do", "dados da", "conforme", "mostram que", "verificou", "checou",
  "consultad", "foi checad", "classificou",
];

const RATING_WORDS = [
  "falso", "falsa", "fake", "enganos", "distorcid", "exagerad", "impreciso", "imprecisa", "sem contexto",
  "insustentavel", "verdadeiro", "verdadeira", "montagem", "nao e bem assim",
];

export interface QuoteInput {
  body: string;
  claimText?: string | null;
  rating?: string | null;
}

export interface QuoteResult {
  quote: string;
  score: number;
  start: number;
}

const MIN_LEN = 40;
const MAX_LEN = 500;

/**
 * Pontua cada sentença do corpo: menção ao rating/veredito, pistas de
 * refutação/fonte, números, sobreposição com a afirmação checada e posição
 * (o veredito costuma vir cedo). Devolve a melhor sentença, literal.
 */
export function selectQuote({ body, claimText, rating }: QuoteInput): QuoteResult | null {
  if (!body.trim()) return null;
  const claimWords = contentWords(claimText ?? "");
  const ratingNorm = rating ? normalizeRating(rating) : null;
  const claimNorm = claimText ? normalizeForMatch(claimText) : null;
  const spans = splitSentences(body);
  let best: QuoteResult | null = null;
  spans.forEach((sp, idx) => {
    const raw = body.slice(sp.start, sp.end);
    if (raw.length < MIN_LEN || raw.length > MAX_LEN) return;
    const n = normalizeForMatch(raw);
    // a própria afirmação repetida não sustenta o veredito
    if (claimNorm && (n === claimNorm || n.includes(claimNorm))) return;
    let score = 0;
    if (ratingNorm && ratingNorm.length > 2 && n.includes(ratingNorm)) score += 3;
    else if (RATING_WORDS.some((w) => n.includes(w))) score += 2;
    score += Math.min(VERDICT_CUES.filter((c) => n.includes(c)).length, 3);
    if (/\d/.test(raw)) score += 1;
    if (claimWords.size) {
      const words = contentWords(raw);
      let hit = 0;
      for (const w of claimWords) if (words.has(w)) hit++;
      score += (hit / claimWords.size) * 3;
    }
    score += idx < spans.length * 0.3 ? 0.5 : 0;
    if (raw.length > 320) score -= 0.5;
    if (!best || score > best.score) best = { quote: raw, score, start: sp.start };
  });
  const chosen = best as QuoteResult | null;
  // limiar mínimo: precisa de alguma evidência de que a sentença sustenta o veredito
  return chosen && chosen.score >= 2.5 ? chosen : null;
}
