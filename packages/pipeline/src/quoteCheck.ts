// Verificação programática da citação: o trecho que o modelo diz ter copiado
// precisa existir no texto da fonte. Funções puras.
import type { ClaimNumber } from "@actually/db";
import { QUOTE_MIN_CHARS, QUOTE_MIN_SIMILARITY } from "./config";
import { extractNumbers, normalizeText } from "./normalize";

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
  // percentual na correção só casa com percentual: "30 municípios" ou "COP30" na fonte não
  // sustentam "caiu 30%". Moeda fica de fora: a série do L2 escreve "1.518 R$" e o número
  // vem sem unidade.
  if ((n.unit === "%" || n.unit === "p.p.") && !k.unit) return false;
  if (k.value === n.value) return true;
  if (exactOnly(n)) return false;
  return Math.abs(k.value - n.value) <= Math.max(0.05, Math.abs(k.value) * 0.01);
}

const CONNECTOR = "(?:e|foi|era|eram|foram|sao|de|da|do|dos|das|o|a|os|as|em|para|com)";
/**
 * Texto (normalizado) que termina contrapondo o número que vem a seguir ao dado correto:
 * negação ("…, não", "e não foi de", "as evidências não mostram", "não chegou a") ou
 * comparação ("mais que", "abaixo de", "superior a", "em vez de"). Só vale para número
 * que o falante disse (ver `numbersSupported`).
 */
const CONTRASTED_BEFORE = new RegExp(
  "(?:^|[^\\p{L}\\p{N}])(?:" +
    `(?:nao|nem)(?:\\s+\\p{L}+){0,2}(?:\\s+${CONNECTOR}){0,2}` +
    "|(?:mais|menos|maior(?:es)?|menor(?:es)?)(?:\\s+do)?\\s+que(?:\\s+(?:os|as|o|a))?" +
    "|(?:acima|abaixo|alem|aquem|longe)\\s+d[aeo]s?" +
    "|(?:superior|inferior)(?:es)?\\s+a[os]?" +
    "|(?:em\\s+vez|ao\\s+inves|em\\s+lugar)\\s+d[aeo]s?" +
    ")$",
  "u",
);
/** Entre dois números contrapostos em sequência ("não chegou a 3 ou 4", "nem 20, nem 30"). */
const CONTRAST_CHAIN = /^\s*(?:,|ou|e|a|ate|nem|-)?\s*$/u;

// --- números por extenso na fonte ("17 anos, quatro meses e 12 dias") ----------------------

const WORD_VALUES: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16,
  dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50,
  sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200,
  duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400,
  quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600, setecentos: 700,
  setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900,
};
const isWord = (w: string | undefined): boolean => w !== undefined && (w in WORD_VALUES || w === "mil");

/**
 * Inteiros escritos por extenso, compostos com "e" ("vinte e cinco", "dois mil e quinhentos").
 * "um"/"uma" sozinhos são artigo e não contam ("uma obra").
 */
export function wordNumbers(text: string): number[] {
  const words = normalizeText(text).split(" ");
  const out: number[] = [];
  const digit = (s: string | undefined) => s !== undefined && /^\d/.test(s);
  for (let i = 0; i < words.length; ) {
    const w = words[i]!;
    const skip =
      !isWord(w) ||
      ((w === "um" || w === "uma") && words[i + 1] !== "mil") ||
      // "3 mil": o mil é escala do número em dígitos, não "mil" sozinho
      (w === "mil" && digit(words[i - 1])) ||
      // "2 mil e quinhentos": o resto já está no número de antes
      (words[i - 1] === "e" && (words[i - 2] === "mil" || digit(words[i - 2])));
    if (skip) {
      i++;
      continue;
    }
    let total = 0;
    let cur = 0;
    let j = i;
    while (j < words.length && isWord(words[j])) {
      const tok = words[j]!;
      if (tok === "mil") {
        total += (cur || 1) * 1000;
        cur = 0;
      } else {
        cur += WORD_VALUES[tok]!;
      }
      j++;
      // continua em "e <número>" e logo depois de "mil" ("mil novecentos e oitenta")
      if (words[j] === "e" && isWord(words[j + 1])) j++;
      else if (tok !== "mil" && words[j] !== "mil") break;
    }
    out.push(total + cur);
    i = j;
  }
  return out;
}

// --- datas: comparadas inteiras, em qualquer formato -----------------------------------------

const MONTH_NAMES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8,
  setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const MONTH_ABBR: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};
const MONTH_RE = "janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";
const ABBR_RE = "jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez";
const DATE_RE = new RegExp(
  [
    // 18/10/2026, 7/5/2026, 05/02/26, 16/10
    `(?<![\\p{N}/.,])(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?(?![\\p{N}/])`,
    // 24.set.2026 (Poder360)
    `(?<![\\p{N}.])(\\d{1,2})\\.(${ABBR_RE})\\.(\\d{4})(?![\\p{N}])`,
    // 7 de maio de 2026, 1º de janeiro
    `(?<![\\p{N}.,])(\\d{1,2})º?\\s+de\\s+(${MONTH_RE})(?:\\s+de\\s+(\\d{4}))?(?![\\p{L}])`,
    // maio de 2026, maio/2026
    `(?<![\\p{L}])(${MONTH_RE})(?:\\s+de\\s+|\\s*/\\s*)(\\d{4})(?![\\p{N}])`,
    // ago/2026, dez/2024
    `(?<![\\p{L}])(${ABBR_RE})\\.?/(\\d{4})(?![\\p{N}])`,
    // 2026-10-18
    `(?<![\\p{N}-])(\\d{4})-(\\d{2})-(\\d{2})(?![\\p{N}])`,
  ].join("|"),
  "giu",
);

interface FoundDate {
  start: number;
  end: number;
  raw: string;
  day: number | null;
  month: number;
  year: number | null;
  /** Onde começa o ano no texto (mês/ano sem dia: o ano ainda pode valer como número). */
  yearAt: number | null;
}

const monthOf = (s: string): number | undefined => {
  const n = normalizeText(s);
  return MONTH_NAMES[n] ?? MONTH_ABBR[n.slice(0, 3)];
};
const fullYear = (y: string | undefined): number | null => (y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : null);

export function findDates(text: string): FoundDate[] {
  const out: FoundDate[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const g = m.slice(1);
    let day: number | null = null;
    let month: number | undefined;
    let yearRaw: string | undefined;
    if (g[0]) [day, month, yearRaw] = [Number(g[0]), Number(g[1]), g[2]];
    else if (g[3]) [day, month, yearRaw] = [Number(g[3]), monthOf(g[4]!), g[5]];
    else if (g[6]) [day, month, yearRaw] = [Number(g[6]), monthOf(g[7]!), g[8]];
    else if (g[9]) [month, yearRaw] = [monthOf(g[9]), g[10]];
    else if (g[11]) [month, yearRaw] = [monthOf(g[11]), g[12]];
    else if (g[13]) [yearRaw, month, day] = [g[13], Number(g[14]), Number(g[15])];
    if (!month || month < 1 || month > 12 || (day !== null && (day < 1 || day > 31))) continue;
    const start = m.index ?? 0;
    const raw = m[0];
    const yearAt = yearRaw ? start + raw.lastIndexOf(yearRaw) : null;
    out.push({ start, end: start + raw.length, raw, day, month, year: fullYear(yearRaw), yearAt });
  }
  return out;
}

interface DateIndex {
  full: Set<string>;
  dayMonth: Set<string>;
  /** Dia e mês citados sem ano ("em 7 de maio"): valem para qualquer ano. */
  dayMonthNoYear: Set<string>;
  monthYear: Set<string>;
}

function dateIndex(sources: string[]): DateIndex {
  const idx: DateIndex = { full: new Set(), dayMonth: new Set(), dayMonthNoYear: new Set(), monthYear: new Set() };
  for (const d of sources.flatMap(findDates)) {
    if (d.day !== null) idx.dayMonth.add(`${d.month}-${d.day}`);
    if (d.day !== null && d.year !== null) idx.full.add(`${d.year}-${d.month}-${d.day}`);
    if (d.day !== null && d.year === null) idx.dayMonthNoYear.add(`${d.month}-${d.day}`);
    if (d.year !== null) idx.monthYear.add(`${d.year}-${d.month}`);
  }
  return idx;
}

/** "ok" = a data está nas fontes; "year" = mês/ano sem par (o ano ainda pode valer como número). */
function dateSupported(d: FoundDate, idx: DateIndex): "ok" | "year" | "no" {
  if (d.day !== null && d.year !== null) {
    return idx.full.has(`${d.year}-${d.month}-${d.day}`) || idx.dayMonthNoYear.has(`${d.month}-${d.day}`) ? "ok" : "no";
  }
  if (d.day !== null) return idx.dayMonth.has(`${d.month}-${d.day}`) ? "ok" : "no";
  return idx.monthYear.has(`${d.year}-${d.month}`) ? "ok" : "year";
}

const CITATION_RE = /((?:segundo|de acordo com|conforme)\s+[^()\n.;:]{1,80}?)\s*\(([^()]{1,80})\)/giu;

/**
 * Data de citação que não dá para conferir sai do texto, em vez de calar o alerta:
 * "Segundo o g1 (10/04/2026), …" → "Segundo o g1, …"; "(Fato ou Fake, 19/10/2026)" →
 * "(Fato ou Fake)". É a data da matéria, não um dado sobre a fala — mas sem par numa
 * fonte verificada (texto ou data de publicação) ela não vai a público.
 */
export function dropUnverifiedCitationDates(text: string, sources: string[]): string {
  if (!text) return text;
  const idx = dateIndex(sources);
  const years = new Set(sources.flatMap((s) => extractNumbers(s)).filter((n) => n.unit === null).map((n) => n.value));
  return text.replace(CITATION_RE, (whole, lead: string, inner: string) => {
    const parts = inner.split(/,\s*/);
    const last = parts.at(-1)!.trim();
    const found = findDates(last);
    const isDate = found.length === 1 && found[0]!.raw === last;
    const isYear = /^\d{4}$/.test(last);
    if (!isDate && !isYear) return whole;
    const ok = isYear
      ? years.has(Number(last))
      : ((v) => v === "ok" || (v === "year" && years.has(found[0]!.year!)))(dateSupported(found[0]!, idx));
    if (ok) return whole;
    return parts.length > 1 ? `${lead} (${parts.slice(0, -1).join(", ")})` : lead;
  });
}

// --- identificadores: rodovia e ato normativo ------------------------------------------------

// sigla de estado só com hífen ("SP-280"); a BR também sem ("BR 319", como a transcrição escreve)
const ROAD_RE = /(?<![\p{L}\p{N}])(BR[-\s]?|(?:SP|RJ|MG|RS|PR|SC|BA|PE|CE|GO|MT|MS|PA|AM|RO|AC|AP|RR|TO|MA|PI|RN|PB|AL|SE|ES|DF)-)(\d{2,3})(?![\p{N}])/gu;
const ACT_RE = new RegExp(
  "(?<![\\p{L}])(lei\\s+complementar|lei|decreto-lei|decreto|portaria|resolu[cç][aã]o|ac[oó]rd[aã]o|emenda\\s+constitucional|" +
    "medida\\s+provis[oó]ria|projeto\\s+de\\s+lei|proposta\\s+de\\s+emenda\\s+[àa]\\s+constitui[cç][aã]o|mp|pec|plp|pl|ec|adi|adpf|adc)" +
    "\\s*(?:n(?:[º°o]|\\.º)?\\.?\\s*)?(\\d[\\d.]*\\d|\\d)(?:\\s*/\\s*(\\d{4}|\\d{2}))?(?![\\p{N}])",
  "giu",
);
const ACT_CODE: Record<string, string> = {
  "lei complementar": "lc", "decreto-lei": "dl", "emenda constitucional": "ec", "medida provisoria": "mp",
  "projeto de lei": "pl", "proposta de emenda a constituicao": "pec",
};

interface FoundId {
  start: number;
  end: number;
  key: string;
  year: number | null;
  road: boolean;
}

function findIdentifiers(text: string): FoundId[] {
  const out: FoundId[] = [];
  for (const m of text.matchAll(ROAD_RE)) {
    const code = m[1]!.replace(/[-\s]/g, "").toLowerCase();
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, key: `rodovia:${code}${m[2]}`, year: null, road: true });
  }
  for (const m of text.matchAll(ACT_RE)) {
    const name = normalizeText(m[1]!).replace(/\s+/g, " ");
    const code = ACT_CODE[name] ?? name.replace(/ /g, "");
    out.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      key: `${code}:${m[2]!.replace(/\./g, "")}`,
      year: fullYear(m[3]),
      road: false,
    });
  }
  return out;
}

/** Troca um trecho por espaços (as posições continuam as mesmas do texto original). */
const blank = (s: string, start: number, end: number) => s.slice(0, start) + " ".repeat(end - start) + s.slice(end);

/**
 * Todo número dito na correção/resumo precisa aparecer num trecho VERIFICADO:
 * a citação casada e a frase em volta (`QuoteCheckResult.context`) ou o texto
 * do L2 gerado em código — nunca o documento inteiro.
 * - Número por extenso na fonte vale ("quatro meses" sustenta "4 meses").
 * - Data é comparada inteira e em qualquer formato ("7/5/2026" = "7 de maio de 2026"),
 *   nunca pelos pedaços (o "04" de "10/04/2026" não é um número).
 * - Rodovia e ato normativo (BR-319, EC 123, Lei 13.756/2018) valem como nome, em qualquer
 *   grafia que esteja na fonte; rodovia também quando o falante a nomeou.
 * - Números da fala (`refuted`) não sustentam nada: só passam contrapostos ao dado correto
 *   ("7,8%, não 12%", "não chegou a 3 ou 4 vezes", "mais que 6.000") e iguais ao que foi
 *   dito — nunca como o dado correto.
 * Anos, nº de lei e outros inteiros sem unidade exigem igualdade exata; o resto
 * tolera arredondamento (1% relativo ou 0,05). Unidades diferentes não casam.
 */
export function numbersSupported(
  text: string,
  sources: string[],
  opts: {
    /** Fala literal (trecho original, segmento, falas anteriores do mesmo falante): vale para qualquer número contraposto. */
    refuted?: string[];
    /** Afirmação reformulada: só vale para número com unidade ("7,5%" de "7 e meio por 100"). */
    refutedWithUnit?: string[];
  } = {},
): { ok: boolean; unsupported: string[] } {
  const known: ClaimNumber[] = sources.flatMap((s) => [
    ...extractNumbers(s),
    ...wordNumbers(s).map((value) => ({ value, unit: null, raw: String(value) })),
  ]);
  const said = [
    ...(opts.refuted ?? []).flatMap((s) => extractNumbers(s)),
    ...(opts.refutedWithUnit ?? []).flatMap((s) => extractNumbers(s)).filter((n) => n.unit !== null),
  ];
  const unsupported: string[] = [];
  let rest = text;

  // nomes com número: na fonte em qualquer grafia (e rodovia também na fala); senão, os
  // números do nome seguem para a conferência normal, como antes
  const sourceIds = sources.flatMap(findIdentifiers);
  const saidIds = [...(opts.refuted ?? []), ...(opts.refutedWithUnit ?? [])].flatMap(findIdentifiers).filter((i) => i.road);
  for (const id of findIdentifiers(text)) {
    const same = (o: FoundId) => o.key === id.key && (id.year === null || o.year === null || o.year === id.year);
    if (sourceIds.some(same) || saidIds.some(same)) rest = blank(rest, id.start, id.end);
  }

  const dates = dateIndex(sources);
  for (const d of findDates(rest)) {
    const v = dateSupported(d, dates);
    if (v === "year") {
      rest = blank(rest, d.start, d.yearAt!); // o mês sai; o ano fica para a conferência dos números
      continue;
    }
    if (v === "no") unsupported.push(d.raw);
    rest = blank(rest, d.start, d.end);
  }

  let pos = 0;
  let chainEnd = -1;
  for (const n of extractNumbers(rest)) {
    const idx = rest.indexOf(n.raw, pos);
    const at = idx >= 0 ? idx : pos;
    pos = idx >= 0 ? idx + n.raw.length : pos;
    if (known.some((k) => sameNumber(n, k))) continue;
    const before = normalizeForQuote(text.slice(0, at));
    const contrasted =
      CONTRASTED_BEFORE.test(before) || (chainEnd >= 0 && CONTRAST_CHAIN.test(normalizeForQuote(text.slice(chainEnd, at))));
    if (contrasted && said.some((k) => sameNumber(n, k))) {
      chainEnd = pos;
      continue;
    }
    chainEnd = -1;
    unsupported.push(n.raw);
  }
  return { ok: unsupported.length === 0, unsupported };
}
