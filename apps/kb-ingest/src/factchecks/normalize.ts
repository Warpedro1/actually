// Normalização comum a todos os coletores de checagens (Google, RSS, Apify):
// recebe o que se sabe da checagem + o texto da página e produz a linha de
// kb_factchecks — ou o motivo de descartá-la. Função pura (testada).
import { lookupSource, type Verdict } from "@actually/db";
import type { DocumentInput } from "../documents/ingest";
import { detectPerson, detectTopic, detectTopics } from "../lib/classify";
import { cleanText, looksLikeHeadline, normalizeForMatch, stripRelatedLinks } from "../lib/text";
import { mapRating, normalizeRating, RATING_TABLE, ratingFromLabel, ratingFromTitle } from "./rating";
import { selectQuote } from "./quote";
import type { ClaimReviewLd } from "../lib/html";

export interface FactcheckCandidate {
  url: string;
  /** Nome da agência (se conhecido pela origem; senão vem de source_tiers). */
  sourceName?: string | null;
  title?: string | null;
  claimText?: string | null;
  claimant?: string | null;
  ratingOriginal?: string | null;
  publishedAt?: string | null;
  /** Página já obtida (texto da busca da Tavily): processCandidates não baixa de novo. */
  page?: PageContent | null;
}

export interface PageContent {
  title: string | null;
  text: string;
  publishedAt: string | null;
  claimReviews: ClaimReviewLd[];
}

export interface FactcheckRow {
  source_name: string;
  url: string;
  claim_text: string;
  rating_original: string;
  verdict: Verdict;
  person: string | null;
  topic: string | null;
  quote: string;
  body: string;
  published_at: string | null;
  /** 'web' = veio da fila kb_web_finds (busca web durante uma checagem); ausente = carga. */
  origin?: string | null;
}

export type BuildResult = { ok: true; row: FactcheckRow } | { ok: false; reason: string };

const MIN_BODY = 300;

/** "É falso que X" → "X" (com maiúscula). */
export function claimFromTitle(title: string): string {
  const stripped = title
    .replace(/^(?:é\s+)?(?:#?fake|#?fato|falso|falsa|enganos[oa]|verdadeir[oa]|exagerad[oa]|distorcid[oa])\s*(?:que\s+|[:|–—-]\s*)/i, "")
    .trim();
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function isoOrNull(d: string | null | undefined): string | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function buildFactcheckRow(c: FactcheckCandidate, page: PageContent): BuildResult {
  const body = page.text;
  if (body.length < MIN_BODY) return { ok: false, reason: "sem_corpo" };

  // ClaimReview do próprio site é a melhor fonte de rating e afirmação.
  const ld = page.claimReviews.find((r) => r.ratingText) ?? page.claimReviews[0];
  const title = c.title ?? page.title ?? null;
  const ratingOriginal =
    c.ratingOriginal?.trim() || ld?.ratingText || ratingFromTitle(title) || ratingFromLabel(body) || null;
  if (!ratingOriginal) return { ok: false, reason: "sem_rating" };

  const claimText = (c.claimText?.trim() || ld?.claimReviewed || (title ? claimFromTitle(title) : "")).trim();
  if (!claimText) return { ok: false, reason: "sem_afirmacao" };

  const verdict = mapRating(ratingOriginal);
  const q = selectQuote({ body, claimText, rating: ratingOriginal });
  if (!q) return { ok: false, reason: "sem_trecho" };
  // garantia: o trecho é literal do corpo guardado
  if (!body.includes(q.quote)) return { ok: false, reason: "trecho_nao_literal" };

  // checagem sem data não vira L1: uma antiga passaria por atual (vai como documento)
  const publishedAt =
    isoOrNull(c.publishedAt) ?? isoOrNull(ld?.datePublished) ?? isoOrNull(page.publishedAt) ?? isoOrNull(dateFromUrl(c.url)) ?? isoOrNull(dateFromText(body));
  if (!publishedAt) return { ok: false, reason: "sem_data" };

  const sourceName = c.sourceName?.trim() || lookupSource(c.url)?.name || new URL(c.url).hostname;
  return {
    ok: true,
    row: {
      source_name: sourceName,
      url: c.url,
      claim_text: claimText,
      rating_original: ratingOriginal,
      verdict,
      person: detectPerson(c.claimant, ld?.claimAuthor, claimText, title),
      topic: detectTopic(claimText, title, body.slice(0, 2000)),
      quote: q.quote,
      body,
      published_at: publishedAt,
    },
  };
}

/** Relevância para o debate: pessoa detectada ou tópico-guia presente. */
export function isRelevant(row: FactcheckRow): boolean {
  return Boolean(row.person || row.topic);
}

/** Chave de deduplicação de URL (sem fragmento, sem utm_*, sem barra final). */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase();
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

export function sameText(a: string, b: string): boolean {
  return normalizeForMatch(a) === normalizeForMatch(b);
}

/** Data no caminho da URL (".../2026/10/20/...") → "2026-10-20"; sem data válida ⇒ null. */
export function dateFromUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /\/((?:19|20)\d{2})\/(\d{2})\/(\d{2})\//.exec(path);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  // 2026/02/31 não é data
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? iso : null;
}

// Data no começo do texto (página sem HTML: Tavily). Formatos das agências e jornais:
// "15/10/2026", "15 de outubro de 2026", "15.out.2026", "15 out 2026", "2026-10-15".
const DATE_HEAD = 2000;
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const DATE_IN_TEXT = new RegExp(
  String.raw`(?<!\d)(?:((?:19|20)\d{2})-(\d{2})-(\d{2})` +
    String.raw`|(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})` +
    String.raw`|(\d{1,2})º?(?:\s+de\s+|\.\s*|\s+)(jan(?:eiro)?|fev(?:ereiro)?|mar(?:ço|co)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)(?:\.?\s+de\s+|\.\s*|\s+)((?:19|20)\d{2}))(?!\d)`,
  "i",
);
/** Linha que abre com "Publicado em"/"Atualizado em" (pode terminar em ponto). */
const DATELINE_START = /^(?:publicad[oa]|atualizad[oa]|publica[cç][aã]o)\b/i;

function isoDate(y: number, m: number, d: number): string | null {
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  // 31/02 não é data
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? iso : null;
}

function dateInLine(line: string): string | null {
  const m = DATE_IN_TEXT.exec(line);
  if (!m) return null;
  if (m[1]) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if (m[4]) return isoDate(Number(m[6]), Number(m[5]), Number(m[4]));
  return isoDate(Number(m[9]), MONTHS.indexOf(normalizeForMatch(m[8]!).slice(0, 3)) + 1, Number(m[7]));
}

/**
 * Data de publicação no começo do texto (primeiros ~2000 caracteres) → "2026-10-15"; sem ⇒ null.
 * Só em linha de data: primeiro a que abre com "Publicado em"/"Atualizado em"; senão a
 * primeira linha curta e sem ponto final (linha de data, assinatura). Data no meio de um
 * parágrafo ("o vídeo, publicado em 12/03/2024, ...") é do assunto, não da página.
 */
export function dateFromText(text: string): string | null {
  const lines = text
    .slice(0, DATE_HEAD)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const accept of [(l: string) => DATELINE_START.test(l), looksLikeHeadline]) {
    for (const line of lines) {
      const iso = accept(line) ? dateInLine(line) : null;
      if (iso) return iso;
    }
  }
  return null;
}

// --- página de lista (home, seção, tag, autor) -----------------------------------------

/** Segmento único que é matéria, não seção: arquivo (.html, .ghtml), id da AFP ou slug de manchete (5+ palavras). */
const ARTICLE_SEGMENT = /\.(?:s?html?|ghtml)$|^doc\.afp\.com\.\w+$|^[^-]+(?:-[^-]+){4,}$/i;
/** Fim de caminho de índice: /noticias, /ultimas-noticias, /tag/x, /autor/x, /categoria/x, /page/2. */
const LISTING_END = /\/(?:noticias|ultimas-noticias)$|\/(?:tags?|autor(?:es)?|author|categorias?|category)\/[^/]+$|\/(?:page|pagina)\/\d+$/;

/**
 * Caminho de página de lista: home ou seção (0–1 segmento, salvo matéria de segmento único
 * como as da AFP), /noticias, /ultimas-noticias, /tag/..., /autor/..., /categoria/...,
 * /page/N, ou a própria seção da agência em SOURCE_TIERS ("g1.globo.com/fato-ou-fake").
 */
export function isListingPath(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return true;
  }
  const segs = path.split("/").filter(Boolean);
  if (!segs.length) return true;
  if (segs.length === 1 && !ARTICLE_SEGMENT.test(segs[0]!)) return true;
  if (LISTING_END.test(`/${segs.join("/")}`)) return true;
  const prefix = lookupSource(url)?.domain.split("/").slice(1).join("/").toLowerCase();
  return Boolean(prefix) && segs.join("/") === prefix;
}

/**
 * Linha que não é manchete nem texto: selo solto ("FALSO", "Classificação: Falso"), fala
 * citada ("“...”", "“...” — Fulano"), linha de data ("Publicado em ...", "14.mar.2030")
 * ou assinatura ("Por Fulano").
 */
function isNeutralLine(line: string): boolean {
  if (RATING_TABLE[normalizeRating(line)] || ratingFromLabel(line)) return true;
  if (/^[“"«‘'].+[”"»’'](?:\s*[—–-].*)?$/.test(line)) return true;
  if (DATELINE_START.test(line) || (line.length <= 60 && dateInLine(line))) return true;
  return /^por\s/i.test(line) && line.length <= 80;
}

/**
 * Mais da metade das linhas não vazias com cara de manchete (curtas, sem ponto final):
 * lista de outras matérias. Selos, falas citadas, datas e assinaturas não contam para
 * nenhum lado (a matéria com várias falas tem fala e selo para cada fala checada).
 */
export function mostlyHeadlines(text: string): boolean {
  // pesa por caracteres, não por linha: matéria de verdade tem parágrafos longos, mesmo com
  // muitos links curtos de "relacionadas" em volta (UOL); lista é quase só manchete
  let counted = 0;
  let headlines = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || isNeutralLine(line)) continue;
    counted += line.length;
    if (looksLikeHeadline(line)) headlines += line.length;
  }
  return headlines * 2 > counted;
}

/**
 * Página de lista (home, seção, tag, autor, "Notícias | Aos Fatos"): cheia de manchetes de
 * outras matérias, com outras datas. Nunca vira documento: um trecho dela citado como
 * evidência seria de outra checagem.
 */
export function isListingPage(url: string, text: string): boolean {
  return isListingPath(url) || mostlyHeadlines(text);
}

/** O sufixo do título é o nome do site da URL ("Aos Fatos", "g1", "Estadão")? */
function isSiteName(suffix: string, url: string): boolean {
  const n = normalizeForMatch(suffix);
  const name = lookupSource(url)?.name;
  if (!name || n.length < 2) return false;
  const site = normalizeForMatch(name);
  return site.includes(n) || n.includes(site);
}

/** Sufixo de título que é só a data ("Manchete - 20/10/2026 - UOL Confere"). */
const DATE_SUFFIX = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/**
 * Título do buscador/da Tavily sem o sufixo do site ("Manchete | Fato ou Fake | g1",
 * "Manchete - Aos Fatos" e "Manchete - 20/10/2026 - UOL Confere" → "Manchete"): o título
 * vira a afirmação quando a página não traz ClaimReview. Vazio ⇒ null.
 */
export function cleanPageTitle(title: string | null | undefined, url: string): string | null {
  let t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const parts = t.split(/\s+\|\s+/);
  if (parts.length > 1 && parts[0]!.length >= 15) t = parts[0]!;
  // tira sufixos enquanto o último for nome do site ou data
  for (;;) {
    const dash = /^(.{15,}?)\s+[-–—]\s+([^-–—]{2,40})$/.exec(t);
    if (!dash || !(isSiteName(dash[2]!, url) || DATE_SUFFIX.test(dash[2]!.trim()))) break;
    t = dash[1]!;
  }
  return t;
}

/**
 * Texto já extraído por outro meio (Tavily) → PageContent, com a mesma limpeza do HTML
 * (cleanText + stripRelatedLinks). Sem HTML não há ClaimReview; a data vem de quem
 * chama, do caminho da URL ou do começo do texto.
 */
export function pageFromText(p: { url: string; title?: string | null; text: string; publishedAt?: string | null }): PageContent {
  const text = stripRelatedLinks(cleanText(p.text));
  // data ilegível do buscador não esconde a da URL ou do texto
  const given = p.publishedAt && Number.isFinite(Date.parse(p.publishedAt)) ? p.publishedAt : null;
  return {
    title: cleanPageTitle(p.title, p.url),
    text,
    publishedAt: given || dateFromUrl(p.url) || dateFromText(text),
    claimReviews: [],
  };
}

/**
 * Matéria de agência de checagem com VÁRIAS falas checadas ("Checamos o debate da Band",
 * cada fala com seu selo, sem selo único): não vira uma checagem L1, mas é conteúdo de
 * agência — entra como documento L3 (tier e nome da agência). Só para página de agência
 * (kind "checagem") com pessoa ou tópico-guia no título + começo do corpo; senão null.
 */
export function agencyStoryDocument(c: FactcheckCandidate, page: PageContent): DocumentInput | null {
  const src = lookupSource(c.url);
  if (src?.kind !== "checagem") return null;
  const title = (c.title ?? page.title ?? "").trim();
  const head = page.text.slice(0, 5000);
  const person = detectPerson(c.claimant, title, head);
  const topics = detectTopics(title, head);
  if (!person && !topics.length) return null;
  return {
    url: c.url,
    title: title || src.name,
    doc_type: "noticia",
    person,
    source_name: c.sourceName?.trim() || src.name,
    tier: src.tier,
    published_at: isoOrNull(c.publishedAt) ?? isoOrNull(page.publishedAt),
    topics: topics.slice(0, 3),
    body: page.text,
  };
}
