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
  return [...keys].sort();
}

const UP = /\b(aument\w*|sub\w*|cresc\w*|alta|elev\w*|dobr\w*|tripl\w*|ampli\w*|recorde)\b/;
const DOWN = /\b(ca[iíu]\w*|queda|diminu\w*|reduz\w*|redu[cç]\w*|baix\w*|recu\w*|despenc\w*|encolh\w*)\b/;
const NEG = /\b(nao|nunca|jamais|nenhum\w*|nem)\b/;

/** Direção (subiu/caiu) e negação — "caiu" e "subiu" nunca são a mesma afirmação. */
export function polaritySignature(textNormalized: string): string {
  const t = normalizeText(textNormalized);
  return `${UP.test(t) ? "U" : ""}${DOWN.test(t) ? "D" : ""}${NEG.test(t) ? "N" : ""}`;
}

/** Duas afirmações semelhantes só são a mesma se números, período e polaridade baterem. */
export function sameFacts(
  a: { text_normalized: string; indicator: IndicatorRef | null },
  b: { text_normalized: string; indicator: IndicatorRef | null },
): boolean {
  const sa = numberSignature(a.text_normalized, a.indicator);
  const sb = numberSignature(b.text_normalized, b.indicator);
  if (sa.length !== sb.length || sa.some((k, i) => k !== sb[i])) return false;
  return polaritySignature(a.text_normalized) === polaritySignature(b.text_normalized);
}
