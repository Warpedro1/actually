// Verificação programática da citação: o trecho que o modelo diz ter copiado
// precisa existir no texto da fonte. Funções puras.
import { QUOTE_MIN_CHARS, QUOTE_MIN_SIMILARITY } from "./config";
import { extractNumbers } from "./normalize";

export interface QuoteCheckResult {
  verified: boolean;
  method: "exact" | "fuzzy" | "none";
  /** 1 = idêntico após normalização. */
  similarity: number;
}

/** Normalização para comparar citações: sem diacríticos, minúsculas, aspas/travessões unificados, espaços colapsados. */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[“”„‟«»″"]/g, '"')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[  -​  　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tira aspas/pontuação das bordas que o modelo costuma acrescentar. */
function trimEdges(s: string): string {
  return s.replace(/^[\s"'.,;:!?\-()[\]]+/, "").replace(/[\s"'.,;:!?\-()[\]]+$/, "");
}

/**
 * Menor distância de edição entre `pattern` e QUALQUER substring de `text`
 * (Sellers): é a "melhor janela" com tamanho livre perto do tamanho do padrão.
 * O(|pattern|·|text|) com duas linhas de memória.
 */
export function bestWindowDistance(pattern: string, text: string): number {
  const m = pattern.length;
  if (m === 0) return 0;
  let prev = new Array<number>(m + 1);
  let cur = new Array<number>(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let best = m;
  for (let j = 1; j <= text.length; j++) {
    cur[0] = 0; // a janela pode começar em qualquer posição do texto
    const tc = text.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      const cost = pattern.charCodeAt(i - 1) === tc ? 0 : 1;
      const a = prev[i - 1]! + cost;
      const b = prev[i]! + 1;
      const c = cur[i - 1]! + 1;
      cur[i] = a < b ? (a < c ? a : c) : b < c ? b : c;
    }
    if (cur[m]! < best) best = cur[m]!;
    [prev, cur] = [cur, prev];
  }
  return best;
}

/** Levenshtein clássico (usado em testes e para strings curtas). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function checkPart(part: string, source: string, minSimilarity: number): QuoteCheckResult {
  if (source.includes(part)) return { verified: true, method: "exact", similarity: 1 };
  const similarity = 1 - bestWindowDistance(part, source) / part.length;
  return similarity >= minSimilarity
    ? { verified: true, method: "fuzzy", similarity }
    : { verified: false, method: "none", similarity };
}

/**
 * O trecho citado existe no texto da fonte? Substring exata após normalização;
 * senão, melhor janela com similaridade ≥ minSimilarity. Elipses ("...", "[...]")
 * separam partes que precisam existir todas, na ordem.
 */
export function quoteCheck(
  quote: string,
  sourceText: string,
  minSimilarity: number = QUOTE_MIN_SIMILARITY,
): QuoteCheckResult {
  const q = trimEdges(normalizeForQuote(quote));
  const src = normalizeForQuote(sourceText);
  if (q.length < QUOTE_MIN_CHARS || !src) return { verified: false, method: "none", similarity: 0 };

  const parts = q.split(/\s*(?:\[\s*\.\.\.\s*\]|\(\s*\.\.\.\s*\)|\.\.\.)\s*/).map(trimEdges).filter(Boolean);
  if (parts.length === 1) return checkPart(parts[0]!, src, minSimilarity);

  // várias partes: cada uma precisa existir (e ser grande o bastante), em ordem
  let cursor = 0;
  let minSim = 1;
  let method: QuoteCheckResult["method"] = "exact";
  for (const part of parts) {
    if (part.length < QUOTE_MIN_CHARS) return { verified: false, method: "none", similarity: 0 };
    const rest = src.slice(cursor);
    const idx = rest.indexOf(part);
    if (idx >= 0) {
      cursor += idx + part.length;
      continue;
    }
    const r = checkPart(part, rest, minSimilarity);
    if (!r.verified) return { verified: false, method: "none", similarity: r.similarity };
    method = "fuzzy";
    minSim = Math.min(minSim, r.similarity);
  }
  return { verified: true, method, similarity: minSim };
}

/**
 * Todo número dito na correção/resumo precisa aparecer em alguma fonte
 * verificada (ou na própria afirmação). Tolera arredondamento (1% relativo ou 0,05).
 */
export function numbersSupported(text: string, sources: string[]): { ok: boolean; unsupported: string[] } {
  const known = sources.flatMap((s) => extractNumbers(s).map((n) => n.value));
  const unsupported: string[] = [];
  for (const n of extractNumbers(text)) {
    const ok = known.some((k) => k === n.value || Math.abs(k - n.value) <= Math.max(0.05, Math.abs(k) * 0.01));
    if (!ok) unsupported.push(n.raw);
  }
  return { ok: unsupported.length === 0, unsupported };
}
