// Normalização comum a todos os coletores de checagens (Google, RSS, Apify):
// recebe o que se sabe da checagem + o texto da página e produz a linha de
// kb_factchecks — ou o motivo de descartá-la. Função pura (testada).
import { lookupSource, type Verdict } from "@actually/db";
import { detectPerson, detectTopic } from "../lib/classify";
import { normalizeForMatch } from "../lib/text";
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
