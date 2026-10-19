// Mapeamento PURO da saída dos Actors da Apify para os formatos do kb-ingest.
//
// ATENÇÃO: os schemas de saída/entrada NÃO puderam ser confirmados na Apify Store
// deste ambiente (api.apify.com bloqueado pelo proxy). Os campos abaixo seguem a
// documentação do plugin Apify instalado (references/workflows/knowledge-base-and-rag.md):
//   website-content-crawler → url, text (markdown limpo), metadata.title, metadata.description, crawledAt
//   google-search-scraper   → organicResults[].url, .title, .snippet
// e são lidos de forma tolerante (vários nomes candidatos). O Actor de transcrição
// do YouTube não tem schema documentado ⇒ leitura tolerante a vários formatos.
// Confirme com `apify-check --actor <id>` antes do uso real.
import { formatTimestamp } from "../transcribe/format";

type Item = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function obj(v: unknown): Item {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : {};
}

export interface CrawledPage {
  url: string;
  title: string | null;
  text: string;
  publishedAt: string | null;
}

/** Item do website-content-crawler → página (texto preferindo `text`, depois `markdown`). */
export function mapCrawlItem(item: Item): CrawledPage | null {
  const meta = obj(item.metadata);
  const crawl = obj(item.crawl);
  const url = str(item.url) ?? str(crawl.loadedUrl) ?? str(meta.canonicalUrl);
  const text = str(item.text) ?? str(item.markdown);
  if (!url || !/^https?:\/\//.test(url) || !text) return null;
  return {
    url,
    title: str(meta.title) ?? str(item.title),
    text: stripMarkdown(text),
    publishedAt: str(meta.publishedAt) ?? str(meta.datePublished) ?? null,
  };
}

/**
 * Markdown → texto simples preservando as palavras (para chunking e citação).
 * Remove marcação de link/imagem/ênfase/cabeçalho; mantém o texto visível.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface YoutubeTranscript {
  url: string;
  title: string | null;
  text: string;
}

interface Seg {
  text: string;
  start: number | null;
}

function segFrom(v: unknown): Seg | null {
  const o = obj(v);
  const text = str(o.text) ?? str(o.snippet) ?? str(o.caption);
  if (!text) return null;
  const startRaw = o.start ?? o.startTime ?? o.offset ?? o.tStartMs;
  let start = typeof startRaw === "number" ? startRaw : typeof startRaw === "string" ? Number(startRaw) : null;
  if (start !== null && !Number.isFinite(start)) start = null;
  if (start !== null && o.tStartMs !== undefined) start = start / 1000;
  return { text, start };
}

/**
 * Item de um Actor de transcrição do YouTube → texto com marcação de tempo.
 * Aceita: `transcript`/`captions`/`subtitles`/`data` como string ou lista de
 * segmentos {text, start|startTime|offset|tStartMs}; `text` como string.
 */
export function mapTranscriptItem(item: Item, fallbackUrl?: string): YoutubeTranscript | null {
  const url = str(item.url) ?? str(item.videoUrl) ?? str(item.inputUrl) ?? str(item.input) ?? fallbackUrl ?? null;
  if (!url || !/^https?:\/\//.test(url)) return null;
  const title = str(item.title) ?? str(item.videoTitle) ?? null;
  for (const key of ["transcript", "captions", "subtitles", "data", "segments"]) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return { url, title, text: v.trim() };
    if (Array.isArray(v)) {
      const segs = v.map(segFrom).filter((s): s is Seg => s !== null);
      if (segs.length) {
        const text = segs.map((s) => (s.start !== null ? `[${formatTimestamp(s.start)}] ${s.text}` : s.text)).join("\n");
        return { url, title, text };
      }
    }
  }
  const t = str(item.text);
  return t ? { url, title, text: t } : null;
}

export interface SearchResult {
  url: string;
  title: string | null;
  snippet: string | null;
  query: string | null;
}

/** Item do google-search-scraper (uma página de resultados) → resultados orgânicos. */
export function mapSearchItem(item: Item): SearchResult[] {
  const query = str(obj(item.searchQuery).term) ?? str(item.searchQuery) ?? null;
  const organic = Array.isArray(item.organicResults) ? item.organicResults : [];
  return organic
    .map((r) => {
      const o = obj(r);
      const url = str(o.url) ?? str(o.link);
      return url ? { url, title: str(o.title), snippet: str(o.snippet) ?? str(o.description), query } : null;
    })
    .filter((r): r is SearchResult => r !== null && /^https?:\/\//.test(r.url));
}

/** Filtra resultados para domínios permitidos (tier 1–2), casando subdomínios. */
export function filterByDomains(results: SearchResult[], domains: string[]): SearchResult[] {
  return results.filter((r) => {
    try {
      const host = new URL(r.url).hostname.replace(/^www\./, "").toLowerCase();
      return domains.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  });
}

/**
 * Substitui marcadores no input do Actor definido no manifesto:
 *   "$START_URLS"      → [{ url }, ...]
 *   "$URLS"            → [url, ...]
 *   "$QUERIES_NEWLINE" → "q1\nq2"
 *   "$QUERIES"         → [q1, q2]
 *   "$MAX_PAGES"       → número
 * Valores que são exatamente o marcador são trocados (mantém o tipo).
 */
export function fillTemplate(input: unknown, tokens: Record<string, unknown>): unknown {
  if (typeof input === "string" && input in tokens) return tokens[input];
  if (Array.isArray(input)) return input.map((v) => fillTemplate(v, tokens));
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fillTemplate(v, tokens)]));
  }
  return input;
}
