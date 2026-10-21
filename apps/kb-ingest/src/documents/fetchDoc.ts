// Download e extração de texto de um documento remoto (HTML ou PDF).
// HTML recusado por HTTP/rede (403 "Access Denied" para a Vercel, 5xx, timeout) é lido
// pela Tavily; robots.txt proibindo continua sendo recusa (ver lib/tavily.ts).
import { extractText } from "unpdf";
import { dateFromUrl } from "../factchecks/normalize";
import { extractPage } from "../lib/html";
import { fetchWithRetry } from "../lib/http";
import { canFallBackToTavily, hasTavilyKey, tavilyExtract, type Warn } from "../lib/tavily";
import { cleanText, stripRelatedLinks } from "../lib/text";

export interface FetchedDoc {
  title: string | null;
  text: string;
  publishedAt: string | null;
  format: "html" | "pdf" | "text";
  /** Lido pela Tavily porque o download direto foi recusado. */
  via?: "tavily";
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { text } = await extractText(bytes, { mergePages: true });
  return cleanText(text);
}

export async function fetchDocument(
  url: string,
  format?: "html" | "pdf" | "text" | null,
  opts: { warn?: Warn } = {},
): Promise<FetchedDoc> {
  let res: Response;
  try {
    res = await fetchWithRetry(url, { respectRobots: true, timeoutMs: 90_000 });
  } catch (e) {
    // só HTML: o texto da Tavily não substitui PDF nem texto puro
    const html = (format ?? "html") === "html" && !/\.pdf($|\?)/i.test(url);
    if (!html || !canFallBackToTavily(e) || !hasTavilyKey()) throw e;
    const page = await tavilyExtract(url, { warn: opts.warn });
    if (!page) throw e;
    return { title: page.title, text: stripRelatedLinks(cleanText(page.text)), publishedAt: dateFromUrl(url), format: "html", via: "tavily" };
  }
  const ctype = res.headers.get("content-type") ?? "";
  const fmt = format ?? (/pdf/i.test(ctype) || /\.pdf($|\?)/i.test(url) ? "pdf" : /text\/plain/i.test(ctype) ? "text" : "html");
  if (fmt === "pdf") {
    return { title: null, text: await pdfToText(new Uint8Array(await res.arrayBuffer())), publishedAt: null, format: "pdf" };
  }
  const body = await res.text();
  if (fmt === "text") return { title: null, text: cleanText(body), publishedAt: null, format: "text" };
  const page = extractPage(body, url);
  return { title: page.title, text: page.text, publishedAt: page.publishedAt, format: "html" };
}
