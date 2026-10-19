// Texto: normalização para comparação, divisão em sentenças (com posições
// LITERAIS no texto original) e estimativa de tokens.

/** Minúsculas, sem acento, espaços colapsados — para comparar, nunca para guardar. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[“”«»"]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Limpa o texto extraído: espaços por linha, no máximo uma linha em branco seguida. */
export function cleanText(s: string): string {
  return s
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface Span {
  start: number;
  end: number;
}

// Abreviações comuns em pt-BR que terminam em ponto e não encerram a frase.
const ABBREV = new Set(
  [
    "sr", "sra", "srs", "sras", "dr", "dra", "drs", "prof", "profa", "jr", "av", "art", "arts",
    "inc", "pág", "pag", "p", "pp", "n", "nº", "no", "núm", "vol", "cap", "ex", "etc", "aprox",
    "min", "máx", "gov", "dep", "sen", "pres", "ltda", "cia", "s.a", "a.c", "d.c", "jan", "fev",
    "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez", "tel", "obs", "op", "cit",
  ].map((s) => s.toLowerCase()),
);

/**
 * Divide em sentenças devolvendo posições no texto ORIGINAL — o trecho
 * `text.slice(start, end)` é sempre literal (requisito da verificação de citação).
 * Quebra em . ! ? … seguidos de espaço e início de frase, e em quebras de linha.
 */
export function splitSentences(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s]!)) s++;
    while (e > s && /\s/.test(text[e - 1]!)) e--;
    if (e > s) spans.push({ start: s, end: e });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      push(i);
      start = i + 1;
      continue;
    }
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
    // consome pontuação/aspas/parênteses de fechamento grudados
    let j = i + 1;
    while (j < text.length && /[.!?…"'”’»)\]]/.test(text[j]!)) j++;
    if (j < text.length && !/\s/.test(text[j]!)) continue; // "6.5", "gov.br"
    // próxima palavra precisa parecer início de frase
    let k = j;
    while (k < text.length && text[k] === " ") k++;
    if (k < text.length && text[k] !== "\n" && !/[A-ZÀ-Ý0-9"“'‘«(\[—–-]/.test(text[k]!)) continue;
    if (ch === ".") {
      const before = /([\p{L}.º]+)$/u.exec(text.slice(Math.max(0, i - 12), i));
      const word = before?.[1]?.toLowerCase();
      if (word && (ABBREV.has(word) || /^\p{L}$/u.test(word))) continue; // "Sr.", "J."
    }
    push(j);
    start = j;
    i = j - 1;
  }
  push(text.length);
  return spans;
}

/** Estimativa barata de tokens (≈ 3,6 caracteres por token em português). */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.6);
}

/** Palavras de conteúdo (≥ 4 letras, sem acento) para medir sobreposição. */
export function contentWords(s: string): Set<string> {
  const STOP = new Set([
    "para", "como", "pelo", "pela", "pelos", "pelas", "mais", "menos", "sobre", "entre", "desde",
    "quando", "onde", "porque", "isso", "esse", "essa", "este", "esta", "aquele", "aquela", "seus",
    "suas", "nossa", "nosso", "foram", "seria", "sido", "tem", "têm", "teve", "ainda", "também",
    "muito", "muita", "todo", "toda", "todos", "todas", "outro", "outra", "qual", "quais", "cada",
    "depois", "antes", "apenas", "mesmo", "mesma", "post", "publicação", "publicacao", "video",
  ]);
  return new Set(
    normalizeForMatch(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}
