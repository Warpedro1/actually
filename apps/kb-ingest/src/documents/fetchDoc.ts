// Download e extração de texto de um documento remoto (HTML ou PDF).
import { extractText } from "unpdf";
import { extractPage } from "../lib/html";
import { fetchWithRetry } from "../lib/http";
import { cleanText } from "../lib/text";

export interface FetchedDoc {
  title: string | null;
  text: string;
  publishedAt: string | null;
  format: "html" | "pdf" | "text";
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { text } = await extractText(bytes, { mergePages: true });
  return cleanText(text);
}

export async function fetchDocument(url: string, format?: "html" | "pdf" | "text" | null): Promise<FetchedDoc> {
  const res = await fetchWithRetry(url, { respectRobots: true, timeoutMs: 90_000 });
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
