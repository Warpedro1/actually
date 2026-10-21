// HTML → texto principal (Readability sobre linkedom) + metadados úteis
// (título, data de publicação e ClaimReview em JSON-LD, que as agências de
// checagem publicam para o Google — é a fonte mais confiável do rating).
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { cleanText, stripRelatedLinks } from "./text";

export interface ClaimReviewLd {
  claimReviewed: string | null;
  ratingText: string | null;
  datePublished: string | null;
  claimAuthor: string | null;
  url: string | null;
}

export interface ExtractedPage {
  title: string | null;
  text: string;
  publishedAt: string | null;
  claimReviews: ClaimReviewLd[];
}

const BLOCK = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,section,article,tr,figcaption,dt,dd,table,ul,ol";

/** textContent com quebra de linha depois de cada bloco (Readability perde parágrafos). */
function blockText(root: any): string {
  const doc = root.ownerDocument ?? root;
  for (const br of Array.from(root.querySelectorAll("br")) as any[]) br.replaceWith(doc.createTextNode("\n"));
  for (const el of Array.from(root.querySelectorAll(BLOCK)) as any[]) {
    el.appendChild(doc.createTextNode("\n"));
  }
  return cleanText(String(root.textContent ?? ""));
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (v && typeof v === "object" && "name" in v) return str((v as { name: unknown }).name);
  return null;
}

function hasType(node: Record<string, unknown>, type: string): boolean {
  return asArray(node["@type"] as string | string[]).some((t) => String(t).toLowerCase() === type.toLowerCase());
}

/** Coleta nós ClaimReview de todos os blocos JSON-LD (inclui @graph e listas). */
export function parseClaimReviews(jsonLdBlocks: string[]): ClaimReviewLd[] {
  const out: ClaimReviewLd[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n["@graph"]) visit(n["@graph"]);
    if (hasType(n, "ClaimReview")) {
      const rating = n.reviewRating as Record<string, unknown> | undefined;
      const item = n.itemReviewed as Record<string, unknown> | undefined;
      out.push({
        claimReviewed: str(n.claimReviewed),
        ratingText: str(rating?.alternateName) ?? str(rating?.name),
        datePublished: str(n.datePublished),
        claimAuthor: str(item?.author),
        url: str(n.url),
      });
    }
  };
  for (const raw of jsonLdBlocks) {
    try {
      visit(JSON.parse(raw));
    } catch {
      // JSON-LD malformado é comum; ignora o bloco
    }
  }
  return out;
}

export function extractPage(html: string, url: string): ExtractedPage {
  const { document } = parseHTML(html);
  const meta = (sel: string) => (document.querySelector(sel) as any)?.getAttribute("content")?.trim() || null;
  const jsonLd = (Array.from(document.querySelectorAll('script[type="application/ld+json"]')) as any[]).map(
    (s) => String(s.textContent ?? ""),
  );
  const claimReviews = parseClaimReviews(jsonLd);
  const publishedAt =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="date"]') ??
    ((document.querySelector("time[datetime]") as any)?.getAttribute("datetime") as string | null) ??
    claimReviews.find((c) => c.datePublished)?.datePublished ??
    null;
  const metaTitle = meta('meta[property="og:title"]');

  // Readability altera o DOM; roda numa cópia.
  const { document: forReader } = parseHTML(html);
  try {
    (forReader as any).documentURI ??= url;
  } catch {
    /* linkedom pode não permitir; Readability só usa para links relativos */
  }
  let text = "";
  let title: string | null = null;
  try {
    const article = new Readability(forReader as any, { charThreshold: 200 }).parse();
    if (article?.content) {
      const { document: content } = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
      text = blockText(content.body);
      title = article.title?.trim() || null;
    }
  } catch {
    // cai no fallback abaixo
  }
  if (text.length < 200) {
    for (const el of Array.from(
      document.querySelectorAll("script,style,noscript,nav,header,footer,aside,form,iframe,svg"),
    ) as any[]) {
      el.remove();
    }
    const main = (document.querySelector("article") ?? document.querySelector("main") ?? document.body) as any;
    if (main) text = blockText(main);
  }
  title ??= metaTitle ?? (document.querySelector("title")?.textContent?.trim() || null);
  return { title, text: stripRelatedLinks(text), publishedAt, claimReviews };
}
