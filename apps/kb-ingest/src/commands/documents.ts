// documents (L3): manifesto sources/documents.yaml OU arquivo local.
//   --manifest sources/documents.yaml   (padrão)
//   --only <trecho da url>              só as entradas cuja URL contém o trecho
//   --file transcricao.txt|.json --meta '{"url":..., "title":..., "doc_type":"debate", ...}'
//   --speakers "0=Lula,1=Flávio Bolsonaro"  (só para .json de transcrição; use após conferir)
//   --force                              refaz chunks mesmo sem mudança no corpo
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { lookupSource, tierForUrl, type DocType, type SourceTier } from "@actually/db";
import type { Ctx } from "../lib/ctx";
import { detectTopics } from "../lib/classify";
import { fetchDocument } from "../documents/fetchDoc";
import { ingestDocument, type DocumentInput } from "../documents/ingest";
import { LocalMeta, loadManifest, type ManifestEntry } from "../documents/manifest";
import { localFileToText, parseSpeakerMap } from "../transcribe/format";

export interface DocumentsOpts {
  manifest: string;
  only?: string;
  file?: string;
  meta?: string;
  speakers?: string;
  force?: boolean;
  skipEmbed?: boolean;
}

/** Metadados do manifesto + texto extraído → DocumentInput (tier/fonte por lookupSource). */
export function toDocumentInput(e: Omit<ManifestEntry, "format">, body: string): DocumentInput {
  const src = lookupSource(e.url);
  return {
    url: e.url,
    title: e.title,
    doc_type: e.doc_type as DocType,
    person: e.person ?? null,
    source_name: e.source_name ?? src?.name ?? new URL(e.url).hostname,
    tier: (e.tier ?? tierForUrl(e.url)) as SourceTier,
    published_at: e.published_at ?? null,
    topics: e.topics?.length ? e.topics : detectTopics(e.title, body.slice(0, 5000)).slice(0, 3),
    body,
  };
}

export async function runDocuments(ctx: Ctx, opts: DocumentsOpts): Promise<void> {
  if (opts.file) {
    if (!opts.meta) throw new Error("--file exige --meta '{\"url\":...,\"title\":...,\"doc_type\":...}'");
    const meta = LocalMeta.parse(JSON.parse(opts.meta));
    const body = localFileToText(readFileSync(opts.file, "utf8"), basename(opts.file), parseSpeakerMap(opts.speakers));
    const r = await ingestDocument(ctx, toDocumentInput(meta, body), opts);
    ctx.log(`${opts.file} → ${meta.url}: ${r}`);
    return;
  }
  let entries = loadManifest(opts.manifest);
  if (opts.only) entries = entries.filter((e) => e.url.includes(opts.only!));
  if (!entries.length) {
    ctx.log(`nenhum documento no manifesto ${opts.manifest} (veja as pendências comentadas no arquivo)`);
    return;
  }
  const result: Record<string, number> = {};
  for (const e of entries) {
    try {
      const fetched = await fetchDocument(e.url, e.format, { warn: ctx.warn });
      const doc = toDocumentInput({ ...e, published_at: e.published_at ?? fetched.publishedAt }, fetched.text);
      const r = await ingestDocument(ctx, doc, opts);
      result[r] = (result[r] ?? 0) + 1;
      ctx.log(`${r.padEnd(8)} ${e.url} (${fetched.format}${fetched.via ? " via Tavily" : ""}, ${fetched.text.length} chars)`);
    } catch (err) {
      result.erro = (result.erro ?? 0) + 1;
      ctx.warn(`${e.url}: ${(err as Error).message}`);
    }
  }
  ctx.log(`documentos: ${JSON.stringify(result)}`);
  if (result.erro) process.exitCode = 1;
}
