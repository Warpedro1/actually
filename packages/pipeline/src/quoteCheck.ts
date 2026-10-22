// Verificação programática da citação: o trecho que o modelo diz ter copiado
// precisa existir no texto da fonte. Funções puras.
import type { ClaimNumber } from "@actually/db";
import { QUOTE_MIN_CHARS, QUOTE_MIN_SIMILARITY } from "./config";
import { extractNumbers } from "./normalize";

export interface QuoteCheckResult {
  verified: boolean;
  method: "exact" | "fuzzy" | "none";
  /** 1 = idêntico após normalização. */
  similarity: number;
  /**
   * Trecho LITERAL da fonte que casou (texto original, só com espaços colapsados).
   * É ele, e nunca o texto do modelo, que vai a público. null se não verificado.
   */
  matched: string | null;
  /**
   * Frase da fonte em volta do trecho casado (até QUOTE_CONTEXT_CHARS de cada lado,
   * sem atravessar fim de frase/linha): onde os números da correção podem estar.
   * null se não verificado.
   */
  context: string | null;
}

/** Quanto a janela de contexto da citação pode crescer para cada lado (caracteres). */
export const QUOTE_CONTEXT_CHARS = 120;

// ---------------------------------------------------------------------------
// Normalização (com mapa de posições de volta para o texto original)
// ---------------------------------------------------------------------------

const WS_RE = /[\s\u00a0\u2000-\u200b\u202f\u205f\u3000]/;
const charCache = new Map<string, string>();

/** Normaliza um caractere não ASCII: sem diacríticos, minúsculo, aspas/travessões unificados, espaço. */
function normalizeChar(ch: string): string {
  if (WS_RE.test(ch)) return " ";
  let n = charCache.get(ch);
  if (n === undefined) {
    n = ch
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[“”„‟«»″"]/g, '"')
      .replace(/[‘’‚‛′`´]/g, "'")
      .replace(/[‐‑‒–—―−]/g, "-")
      .replace(/…/g, "...");
    if (charCache.size < 4096) charCache.set(ch, n);
  }
  return n;
}

interface Normalized {
  text: string;
  /** Para cada unidade de `text`: início (inclusive) no texto original. */
  from: number[];
  /** Para cada unidade de `text`: fim (exclusivo) no texto original. */
  to: number[];
}

function normalizeMapped(s: string): Normalized {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  let lastSpace = true; // nada de espaço no começo
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    let len = 1;
    let n: string;
    if (code < 128) {
      // caminho rápido (a maior parte do texto)
      if (code === 32 || (code >= 9 && code <= 13)) n = " ";
      else if (code >= 65 && code <= 90) n = String.fromCharCode(code + 32);
      else if (code === 96) n = "'"; // crase/backtick
      else n = s[i]!;
    } else {
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) len = 2;
      }
      n = normalizeChar(s.slice(i, i + len));
    }
    for (let k = 0; k < n.length; k++) {
      const c = n[k]!;
      // espaços colapsados
      if (c === " ") {
        if (lastSpace) continue;
        lastSpace = true;
      } else {
        lastSpace = false;
      }
      text += c;
      from.push(i);
      to.push(i + len);
    }
    i += len;
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    from.pop();
    to.pop();
  }
  return { text, from, to };
}

/** Normalização para comparar citações: sem diacríticos, minúsculas, aspas/travessões unificados, espaços colapsados. */
export function normalizeForQuote(s: string): string {
  return normalizeMapped(s).text;
}

/** Tira aspas/pontuação das bordas que o modelo costuma acrescentar (o "-" de um número negativo fica). */
function trimEdges(s: string): string {
  return s.replace(/^(?:[\s"'.,;:!?()[\]]|-(?!\d))+/, "").replace(/[\s"'.,;:!?\-()[\]]+$/, "");
}

// ---------------------------------------------------------------------------
// Distâncias
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Citação
// ---------------------------------------------------------------------------

interface Token {
  t: string;
  /** [s, e) no texto normalizado. */
  s: number;
  e: number;
}

/**
 * Palavras e números do texto normalizado. Número é um token só ("7,8",
 * "1.234,56"), com o sinal de menos quando ele não separa duas palavras
 * ("-0,5", mas "2015-2023" = "2015" + "2023"); "%" e "$" também contam.
 * Pontuação e espaço não.
 */
const TOKEN_RE = /(?:(?<![\p{L}\p{N}])-)?\d+(?:[.,]\d+)*|[\p{L}\p{N}]+|[%$]/gu;

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(TOKEN_RE)) out.push({ t: m[0], s: m.index, e: m.index + m[0].length });
  return out;
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isStop = (c: string | undefined) => c === "." || c === "!" || c === "?" || c === ";";

/**
 * Frase do texto original em volta de [start, end): cresce para cada lado até
 * o fim de frase/linha, no máximo `maxExtra` caracteres, sem cortar palavra.
 */
function sentenceWindow(text: string, start: number, end: number, maxExtra = QUOTE_CONTEXT_CHARS): string {
  let a = start;
  let capped = true;
  while (start - a < maxExtra) {
    if (a === 0) { capped = false; break; }
    const c = text[a - 1];
    if (c === "\n" || (isSpace(c) && isStop(text[a - 2]))) { capped = false; break; }
    a--;
  }
  if (capped) while (a < start && !isSpace(text[a - 1])) a++;

  let b = end;
  capped = true;
  while (b - end < maxExtra) {
    if (b === text.length) { capped = false; break; }
    const c = text[b];
    if (c === "\n") { capped = false; break; }
    if (isStop(c) && (b + 1 === text.length || isSpace(text[b + 1]))) { b++; capped = false; break; }
    b++;
  }
  if (capped) while (b > end && !isSpace(text[b])) b--;
  return text.slice(a, b);
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * O trecho citado existe no texto da fonte? Compara palavra a palavra (após
 * normalização): a sequência de palavras/números da citação precisa aparecer
 * CONTÍGUA e idêntica na fonte, começando e terminando em fronteira de palavra.
 * - "exact": idêntico também na pontuação;
 * - "fuzzy": mesmas palavras e números, só pontuação/espaço diferentes (e
 *   similaridade de caracteres ≥ minSimilarity).
 * Qualquer palavra trocada, inserida ou removida (negação, antônimo, número,
 * data) ⇒ não verificada. Elipse ("...", "[...]") não junta trechos distantes:
 * só passa se nenhuma palavra da fonte foi omitida entre as partes.
 * Verificada ⇒ `matched` traz o texto literal da fonte, que é o que se publica.
 */
export function quoteCheck(
  quote: string,
  sourceText: string,
  minSimilarity: number = QUOTE_MIN_SIMILARITY,
): QuoteCheckResult {
  const none = (similarity: number): QuoteCheckResult => ({ verified: false, method: "none", similarity, matched: null, context: null });
  const q = trimEdges(normalizeForQuote(quote));
  if (q.length < QUOTE_MIN_CHARS) return none(0);
  const src = normalizeMapped(sourceText);
  if (!src.text) return none(0);
  const qTok = tokenize(q);
  if (!qTok.length) return none(0);
  const sTok = tokenize(src.text);

  const found = (method: "exact" | "fuzzy", similarity: number, a: number, b: number): QuoteCheckResult => {
    const oStart = src.from[a]!;
    let oEnd = src.to[b - 1]!;
    // acentos combinantes logo depois do último caractere fazem parte dele
    while (oEnd < sourceText.length && /\p{M}/u.test(sourceText[oEnd]!)) oEnd++;
    return {
      verified: true, method, similarity,
      matched: collapse(sourceText.slice(oStart, oEnd)),
      context: collapse(sentenceWindow(sourceText, oStart, oEnd)),
    };
  };

  let first: [number, number] | null = null;
  outer: for (let i = 0; i + qTok.length <= sTok.length; i++) {
    for (let k = 0; k < qTok.length; k++) if (sTok[i + k]!.t !== qTok[k]!.t) continue outer;
    const a = sTok[i]!.s;
    const b = sTok[i + qTok.length - 1]!.e;
    if (src.text.slice(a, b) === q) return found("exact", 1, a, b);
    first ??= [a, b];
  }
  if (first) {
    const win = src.text.slice(first[0], first[1]);
    const similarity = 1 - levenshtein(q, win) / Math.max(q.length, win.length);
    return similarity >= minSimilarity ? found("fuzzy", similarity, first[0], first[1]) : none(similarity);
  }
  // não casou: a similaridade de caracteres fica só para auditoria
  return none(Math.max(0, 1 - bestWindowDistance(q, src.text) / q.length));
}

// ---------------------------------------------------------------------------
// Números da correção
// ---------------------------------------------------------------------------

/** Inteiro sem unidade, sem multiplicador e sem casa decimal (ano, nº de lei, dia): só vale igual. */
function exactOnly(n: ClaimNumber): boolean {
  return n.unit === null && Number.isInteger(n.value) && !/\d,\d|mil|milh|bilh|trilh/i.test(n.raw);
}

function sameNumber(n: ClaimNumber, k: ClaimNumber): boolean {
  if (n.unit && k.unit && n.unit !== k.unit) return false; // 2% não é 2 p.p.
  // número com unidade na correção só casa com o mesmo número COM unidade: "30 municípios"
  // ou "COP30" na fonte não sustentam "caiu 30%"
  if (n.unit && !k.unit) return false;
  if (k.value === n.value) return true;
  if (exactOnly(n)) return false;
  return Math.abs(k.value - n.value) <= Math.max(0.05, Math.abs(k.value) * 0.01);
}

const CONNECTOR = "(?:e|foi|era|eram|foram|sao|de|da|do|dos|das|o|a|os|as|em|para|com)";
/** Texto (normalizado) que termina em negação: "…, não", "e não foi de", "nem". */
const NEGATED_BEFORE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:nao|nem)(?:\\s+${CONNECTOR}){0,2}$`, "u");

/**
 * Todo número dito na correção/resumo precisa aparecer num trecho VERIFICADO:
 * a citação casada e a frase em volta (`QuoteCheckResult.context`) ou o texto
 * do L2 gerado em código — nunca o documento inteiro.
 * Números da fala (`refuted`) não sustentam nada: só passam quando aparecem
 * negados ("7,8%, não 12%") e batem com o que foi dito — nunca como o dado correto.
 * Anos, nº de lei e outros inteiros sem unidade exigem igualdade exata; o resto
 * tolera arredondamento (1% relativo ou 0,05). Unidades diferentes não casam.
 */
export function numbersSupported(
  text: string,
  sources: string[],
  opts: {
    /** Fala literal (trecho original, segmento, falas anteriores do mesmo falante): vale para qualquer número negado. */
    refuted?: string[];
    /** Afirmação reformulada: só vale para número com unidade ("7,5%" de "7 e meio por 100"). */
    refutedWithUnit?: string[];
  } = {},
): { ok: boolean; unsupported: string[] } {
  const known = sources.flatMap((s) => extractNumbers(s));
  const said = [
    ...(opts.refuted ?? []).flatMap((s) => extractNumbers(s)),
    ...(opts.refutedWithUnit ?? []).flatMap((s) => extractNumbers(s)).filter((n) => n.unit !== null),
  ];
  const unsupported: string[] = [];
  let pos = 0;
  for (const n of extractNumbers(text)) {
    const idx = text.indexOf(n.raw, pos);
    const at = idx >= 0 ? idx : pos;
    pos = idx >= 0 ? idx + n.raw.length : pos;
    if (known.some((k) => sameNumber(n, k))) continue;
    const negated = NEGATED_BEFORE.test(normalizeForQuote(text.slice(0, at)));
    if (negated && said.some((k) => sameNumber(n, k))) continue;
    unsupported.push(n.raw);
  }
  return { ok: unsupported.length === 0, unsupported };
}
