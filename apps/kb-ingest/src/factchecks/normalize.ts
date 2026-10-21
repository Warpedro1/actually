// Normalização comum a todos os coletores de checagens (Google, RSS, Apify):
// recebe o que se sabe da checagem + o texto da página e produz a linha de
// kb_factchecks — ou o motivo de descartá-la. Função pura (testada).
import { lookupSource, type Verdict } from "@actually/db";
import type { DocumentInput } from "../documents/ingest";
import { detectPerson, detectTopic, detectTopics } from "../lib/classify";
import { cleanText, normalizeForMatch, stripRelatedLinks } from "../lib/text";
import { mapRating, ratingFromLabel, ratingFromTitle } from "./rating";
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
      published_at: isoOrNull(c.publishedAt) ?? isoOrNull(ld?.datePublished) ?? isoOrNull(page.publishedAt),
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

/** O sufixo do título é o nome do site da URL ("Aos Fatos", "g1", "Estadão")? */
function isSiteName(suffix: string, url: string): boolean {
  const n = normalizeForMatch(suffix);
  const name = lookupSource(url)?.name;
  if (!name || n.length < 2) return false;
  const site = normalizeForMatch(name);
  return site.includes(n) || n.includes(site);
}

/**
 * Título do buscador/da Tavily sem o sufixo do site ("Manchete | Fato ou Fake | g1" e
 * "Manchete - Aos Fatos" → "Manchete"): o título vira a afirmação quando a página não
 * traz ClaimReview. Vazio ⇒ null.
 */
export function cleanPageTitle(title: string | null | undefined, url: string): string | null {
  let t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const parts = t.split(/\s+\|\s+/);
  if (parts.length > 1 && parts[0]!.length >= 15) t = parts[0]!;
  const dash = /^(.{15,}?)\s+[-–—]\s+([^-–—]{2,40})$/.exec(t);
  if (dash && isSiteName(dash[2]!, url)) t = dash[1]!;
  return t;
}

/**
 * Texto já extraído por outro meio (Tavily) → PageContent, com a mesma limpeza do HTML
 * (cleanText + stripRelatedLinks). Sem HTML não há ClaimReview; a data vem de quem
 * chama ou do caminho da URL.
 */
export function pageFromText(p: { url: string; title?: string | null; text: string; publishedAt?: string | null }): PageContent {
  return {
    title: cleanPageTitle(p.title, p.url),
    text: stripRelatedLinks(cleanText(p.text)),
    publishedAt: p.publishedAt || dateFromUrl(p.url),
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
