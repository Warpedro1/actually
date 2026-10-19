// Normalização de texto (hash da trava de repetição) e de números em pt-BR.
import { createHash } from "node:crypto";
import type { ClaimNumber, IndicatorRef } from "@actually/db";

/** Minúsculas, sem acento, sem pontuação, espaços colapsados. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 (hex) do texto normalizado — chave da trava de repetição no debate. */
export function claimHash(textNormalized: string): string {
  return createHash("sha256").update(normalizeText(textNormalized), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Números pt-BR
// ---------------------------------------------------------------------------

const MULTIPLIERS: [RegExp, number][] = [
  [/^mil$/, 1e3],
  [/^milh(?:ão|ao|ões|oes)$/, 1e6],
  [/^bilh(?:ão|ao|ões|oes)$/, 1e9],
  [/^trilh(?:ão|ao|ões|oes)$/, 1e12],
];

const WORD_NUMBERS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, "três": 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7,
  oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15,
  dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40,
  cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100, meio: 0.5, meia: 0.5,
};

/** Unidade canônica a partir do que foi dito/extraído. */
export function canonicalUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const u = normalizeText(unit.replace(/%/g, " pct ").replace(/R\$/gi, " brl ").replace(/US\$/gi, " usd ").replace(/²/g, "2"));
  if (!u) return null;
  if (/\b(pct|por cento|percent|porcento)\b/.test(u)) return "%";
  if (/\b(p ?p|pontos? percentua(?:l|is))\b/.test(u)) return "p.p.";
  if (/\b(brl|reais|real)\b/.test(u)) return "R$";
  if (/\b(usd|dolar|dolares)\b/.test(u)) return "US$";
  if (/\b(km2|quilometros quadrados|km quadrados)\b/.test(u)) return "km2";
  if (/\b(hectares?|ha)\b/.test(u)) return "ha";
  return u;
}

function multiplierOf(word: string | undefined): number {
  if (!word) return 1;
  const w = word.toLowerCase();
  for (const [re, m] of MULTIPLIERS) if (re.test(w)) return m;
  return 1;
}

/** "1.500" → 1500; "6,5" → 6.5; "1.5" → 1.5; "1.234,56" → 1234.56. */
export function parseNumericLiteral(lit: string): number | null {
  let s = lit.trim();
  if (!/^\d[\d.,]*$/.test(s)) return null;
  if (s.includes(",")) {
    // vírgula decimal; pontos são milhar
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, ""); // milhar pt-BR
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

const MULT_RE = "mil|milh(?:ão|ao|ões|oes)|bilh(?:ão|ao|ões|oes)|trilh(?:ão|ao|ões|oes)";
const UNIT_RE = "%|por\\s+cento|pontos?\\s+percentua(?:l|is)|p\\.\\s?p\\.?|km²|km2|quil[ôo]metros\\s+quadrados|hectares|reais|d[óo]lares";
const QUAL_RE = "quase|cerca\\s+de|mais\\s+de|menos\\s+de|aproximadamente|uns|umas|em\\s+torno\\s+de|perto\\s+de";
const WORD_RE = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join("|");

// Cifrão opcional · literal numérico ou número por extenso · multiplicador opcional · "de" · unidade opcional
const NUMBER_RE = new RegExp(
  `(?:(${QUAL_RE})\\s+)?` +
  `(R\\$|US\\$)?\\s*` +
  `(?:(\\d[\\d.,]*\\d|\\d)|\\b(${WORD_RE})\\b(?=\\s+(?:${MULT_RE}|por\\s+cento)\\b))` +
  `(?:\\s*(${MULT_RE})\\b)?` +
  `(?:\\s*(?:de\\s+)?(${UNIT_RE}))?`,
  "giu",
);

/** Extrai números de um texto em pt-BR ("1,5 milhão", "6%", "quase 10 milhões", "R$ 600"). */
export function extractNumbers(text: string): ClaimNumber[] {
  const out: ClaimNumber[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const [raw, , currency, lit, word, mult, unitRaw] = m;
    let base: number | null = null;
    if (lit) base = parseNumericLiteral(lit);
    else if (word) base = WORD_NUMBERS[word.toLowerCase()] ?? null;
    if (base === null) continue;
    // "reais"/"dólares" depois do número valem como unidade; cifrão antes também
    const unit = canonicalUnit(currency ?? unitRaw ?? null);
    // trailing "." ou "," capturado pelo literal (fim de frase) já foi rejeitado pelo \d final
    const value = roundSig(base * multiplierOf(mult));
    out.push({ value, unit, raw: raw.trim() });
  }
  return out;
}

/** Interpreta um número isolado ("1,5 milhão"); null se não houver número. */
export function parsePtBrNumber(raw: string): ClaimNumber | null {
  return extractNumbers(raw)[0] ?? null;
}

/** Arredonda para 9 algarismos significativos (evita 1.4999999999). */
export function roundSig(v: number, digits = 9): number {
  if (v === 0 || !Number.isFinite(v)) return v;
  return Number(v.toPrecision(digits));
}

/**
 * Normaliza a lista de números vinda do modelo: se o trecho bruto é
 * interpretável deterministicamente, o valor do código prevalece.
 */
const KNOWN_UNITS = new Set(["%", "p.p.", "R$", "US$", "km2", "ha"]);

export function normalizeClaimNumbers(numbers: ClaimNumber[]): ClaimNumber[] {
  return numbers.map((n) => {
    const parsed = parsePtBrNumber(n.raw);
    if (parsed) {
      // unidade do modelo só complementa se for unidade de verdade (não "milhão")
      const modelUnit = canonicalUnit(n.unit);
      return { value: parsed.value, unit: parsed.unit ?? (modelUnit && KNOWN_UNITS.has(modelUnit) ? modelUnit : null), raw: n.raw };
    }
    return { value: roundSig(n.value), unit: canonicalUnit(n.unit), raw: n.raw };
  });
}

// ---------------------------------------------------------------------------
// Assinatura numérica e de polaridade (trava de repetição)
// ---------------------------------------------------------------------------

/**
 * Conjunto canônico de números/período de uma afirmação. Calculado do texto
 * normalizado (estável entre extrações) + período do indicador.
 */
export function numberSignature(textNormalized: string, indicator: IndicatorRef | null): string[] {
  const keys = new Set<string>();
  for (const n of extractNumbers(textNormalized)) keys.add(`${n.unit ?? ""}:${roundSig(n.value, 6)}`);
  if (indicator?.period) keys.add(`periodo:${indicator.period}`);
  if (indicator?.claimed_value != null) keys.add(`${canonicalUnit(indicator.unit) ?? ""}:${roundSig(indicator.claimed_value, 6)}`);
  // "maior da série" (max) e "menor da série" (min), nível e variação: fatos diferentes
  if (indicator?.kind) keys.add(`tipo:${indicator.kind}`);
  return [...keys].sort();
}

/**
 * Polos de direção/posição (texto já sem acento e em minúsculas). Duas
 * afirmações só são a mesma se acionarem exatamente os mesmos polos: "subiu" x
 * "caiu", "a favor" x "contra", "maior" x "menor", "superávit" x "déficit",
 * "aprovou" x "rejeitou", "sim" x "não"... A lista é larga de propósito: palavra
 * de polo a mais de um lado já basta para não ser repetição (verifica de novo).
 */
const POLES: readonly (readonly [string, RegExp])[] = [
  ["sobe", /\b(aument\w*|sub\w*|sob(?:e|em)|cresc\w*|alta|altas|elev\w*|dobr\w*|tripl\w*|quadrupl\w*|ampli\w*|recorde\w*|avanc\w*|expan\w*|dispar\w*|acelera\w*)\b/],
  ["desce", /\b(ca[iu]\w*|queda\w*|diminu\w*|reduz\w*|reduc\w*|baix\w*|recu\w*|despenc\w*|encolh\w*|desc(?:e|eu|er|ida|endo)|retra\w*|desaceler\w*|cort\w*|enxug\w*)\b/],
  ["nega", /\b(nao|nunca|jamais|nenhum\w*|nem|ninguem|nada|sem)\b/],
  ["sim", /\bsim\b/],
  ["favor", /\b(a favor|favorave\w*|apoi\w*|defend\w*)\b/],
  ["contra", /\b(contra|contrari\w*|op(?:os|or|oe|oem|ondo|unha|unham|useram))\b/],
  ["aprova", /\b(aprov\w*|sancion\w*|promulg\w*|ratific\w*|acat\w*)\b/],
  ["rejeita", /\b(rejeit\w*|reprov\w*|vet(?:o|os|ou|ar|ado|ada|aram)|derrub\w*|arquiv\w*|recus\w*|revog\w*|barr(?:ou|ar|ado|ada|aram))\b/],
  ["mais", /\b(mais|maior\w*|acima|superior\w*|super(?:ou|a|am|aram|ar|ando|ado|ada)|ultrapass\w*|exced\w*)\b/],
  ["menos", /\b(menos|menor\w*|abaixo|inferior\w*)\b/],
  ["melhor", /\bmelhor\w*\b/],
  ["pior", /\bpior\w*\b/],
  ["maximo", /\bmaxim\w*\b/],
  ["minimo", /\bminim\w*\b/],
  ["superavit", /\b(superavit\w*|lucr\w*)\b/],
  ["deficit", /\b(deficit\w*|prejuiz\w*|rombo\w*)\b/],
  ["positivo", /\bpositiv\w*\b/],
  ["negativo", /\bnegativ\w*\b/],
  ["ganha", /\b(ganh\w*|venc\w*)\b/],
  ["perde", /\b(perd\w*|derrot\w*)\b/],
  ["cria", /\b(cri(?:ou|ar|ado|ada|ados|adas|acao|aram|ei|amos)|implant\w*|inaugur\w*|fund(?:ou|ado|ada|aram))\b/],
  ["extingue", /\b(extin\w*|acab(?:ou|ar|ado|ada|aram)|encerr\w*|elimin\w*|abol\w*|fech(?:ou|ar|ado|ada|aram))\b/],
  ["permite", /\b(permit\w*|liber\w*|autoriz\w*|legaliz\w*)\b/],
  ["proibe", /\b(proib\w*|bloque\w*|impedi\w*|imped(?:e|em)|criminaliz\w*)\b/],
  ["privatiza", /\bprivatiz\w*\b/],
  ["estatiza", /\b(estatiz\w*|reestatiz\w*|nacionaliz\w*)\b/],
  ["primeiro", /\bprimeir\w*\b/],
  ["ultimo", /\bultim\w*\b/],
  ["antes", /\b(antes|anterior\w*)\b/],
  ["depois", /\b(depois|apos|posterior\w*)\b/],
  ["todos", /\b(todos|todas|tudo|sempre)\b/],
];

/** Polos de comparação: a ordem dos termos importa ("A cresceu mais que B" ≠ "B cresceu mais que A"). */
const RELATIONAL_POLES = new Set(["mais", "menos", "melhor", "pior", "antes", "depois", "ganha", "perde"]);

/** Direção, posição e negação — "caiu"/"subiu", "a favor"/"contra" nunca são a mesma afirmação. */
export function polaritySignature(textNormalized: string): string {
  const t = normalizeText(textNormalized);
  return POLES.filter(([, re]) => re.test(t)).map(([name]) => name).join("|");
}

// Palavras sem conteúdo próprio (e números/unidades, que já entram na assinatura numérica).
const STOPWORDS = new Set([
  "o", "a", "os", "as", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
  "por", "pelo", "pela", "pelos", "pelas", "para", "pra", "com", "e", "ou", "que", "se", "ao", "aos", "ate", "entre",
  "sobre", "seu", "sua", "seus", "suas", "este", "esta", "esse", "essa", "isso", "isto", "ja",
]);
const NUMBER_TOKENS = new Set([
  ...Object.keys(WORD_NUMBERS).map(normalizeText),
  "mil", "milhao", "milhoes", "bilhao", "bilhoes", "trilhao", "trilhoes",
  "cento", "porcento", "pct", "ponto", "pontos", "percentual", "percentuais", "pp", "p",
  "r", "rs", "us", "usd", "brl", "real", "reais", "dolar", "dolares",
]);

/** Palavras de conteúdo (sem acento, em minúsculas), na ordem; `caps` = as que aparecem com inicial maiúscula. */
function contentWords(text: string): { words: string[]; caps: Set<string> } {
  const raw = text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const words: string[] = [];
  const caps = new Set<string>();
  for (const w of raw) {
    const lw = w.toLowerCase();
    if (STOPWORDS.has(lw) || NUMBER_TOKENS.has(lw) || /^\d+$/.test(lw)) continue;
    words.push(lw);
    if (/^\p{Lu}/u.test(w)) caps.add(lw);
  }
  return { words, caps };
}

/** "legal"/"ilegal", "constitucional"/"inconstitucional", "emprego"/"desemprego". */
const NEG_PREFIXES = ["in", "im", "i", "ir", "des", "anti"];
function negatedPair(x: string, y: string): boolean {
  if (Math.min(x.length, y.length) < 4) return false;
  return NEG_PREFIXES.some((p) => x === p + y || y === p + x);
}

/**
 * Diferenças de redação que mudam o fato mesmo com os mesmos polos: palavra
 * com prefixo de negação de um lado só, nome próprio diferente ("Lula criou" x
 * "Bolsonaro criou") e, em comparação, os mesmos termos em outra ordem.
 */
function sameWording(a: string, b: string, poles: string): boolean {
  const wa = contentWords(a);
  const wb = contentWords(b);
  const setA = new Set(wa.words);
  const setB = new Set(wb.words);
  const onlyA = wa.words.filter((w) => !setB.has(w));
  const onlyB = wb.words.filter((w) => !setA.has(w));
  if (onlyA.some((x) => onlyB.some((y) => negatedPair(x, y)))) return false;
  if (onlyA.some((w) => wa.caps.has(w)) || onlyB.some((w) => wb.caps.has(w))) return false;
  if (poles.split("|").some((p) => RELATIONAL_POLES.has(p))) {
    const orderA = wa.words.filter((w) => setB.has(w)).join(" ");
    const orderB = wb.words.filter((w) => setA.has(w)).join(" ");
    if (orderA !== orderB) return false;
  }
  return true;
}

/**
 * Duas afirmações semelhantes só são a mesma se números, período, tipo de
 * indicador, polaridade e redação essencial baterem. Na dúvida, não são
 * (a afirmação é verificada de novo — custa latência, nunca um veredito errado).
 */
export function sameFacts(
  a: { text_normalized: string; indicator: IndicatorRef | null },
  b: { text_normalized: string; indicator: IndicatorRef | null },
): boolean {
  const sa = numberSignature(a.text_normalized, a.indicator);
  const sb = numberSignature(b.text_normalized, b.indicator);
  if (sa.length !== sb.length || sa.some((k, i) => k !== sb[i])) return false;
  const pa = polaritySignature(a.text_normalized);
  if (pa !== polaritySignature(b.text_normalized)) return false;
  return sameWording(a.text_normalized, b.text_normalized, pa);
}
