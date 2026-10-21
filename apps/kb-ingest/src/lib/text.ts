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

// Chamada de "outras matérias" no meio ou no fim do texto ("Leia mais:", "Leia também",
// "Leia mais sobre o debate"). O resto da linha, se houver, é uma manchete.
const RELATED = /^(leia (mais|tamb[ée]m)|saiba mais|veja (mais|tamb[ée]m))\b\s*([:\-–—]?)\s*(.*)$/i;
// "4.dez.2025 – ...", "7/11/2025 – ...", "28/08/07 - ..."
const DATED_HEADLINE = /^\d{1,2}[./](\d{1,2}|[a-zç]{3,4})\.?[./]?\d{2,4}\s*[–—-]\s+\S/i;
const NOISE = /^(publicidade|>+\s*siga\b.*|siga (o|a) .{1,60} no (whatsapp|telegram|instagram)\b.*)$/i;

/** Linha com cara de manchete: curta e sem pontuação de fim de frase. */
const looksLikeHeadline = (l: string) => l.length <= 160 && !/[.!?:;…"”)]$/.test(l);

/**
 * Tira do texto da matéria as listas de manchetes de outras matérias e o ruído de página
 * ("publicidade", "Siga o canal"). O pipeline cita trechos literais do texto como evidência,
 * e uma manchete de outra matéria (com outra data) não pode virar citação.
 * - "Leia mais:" sozinho ou como título de lista: sai com as linhas seguintes que forem
 *   manchetes (datadas ou curtas sem ponto final).
 * - "Leia mais: <manchete>" numa linha: sai a linha e só as manchetes datadas logo abaixo
 *   (um intertítulo curto depois dela é do texto).
 */
export function stripRelatedLinks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (NOISE.test(line)) continue;
    const m = line.length <= 200 ? RELATED.exec(line) : null;
    if (!m) {
      out.push(lines[i]!);
      continue;
    }
    // título de lista: "Leia mais:" sozinho ou "Leia mais sobre o debate"; o resto é linha única
    const inline = !(m[5] === "" || (m[4] === "" && /^sobre\b/i.test(m[5]!)));
    const isItem = (l: string) => DATED_HEADLINE.test(l) || (!inline && looksLikeHeadline(l));
    // pula as manchetes seguintes (com as linhas em branco entre elas)
    let j = i + 1;
    for (;;) {
      let k = j;
      while (k < lines.length && !lines[k]!.trim()) k++;
      if (k >= lines.length || !isItem(lines[k]!.trim())) break;
      j = k + 1;
    }
    i = j - 1;
  }
  return cleanText(out.join("\n"));
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
