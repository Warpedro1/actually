// Ingestão de um documento L3: upsert em kb_documents + chunks (com embeddings)
// em kb_chunks. Idempotente: mesmo URL e mesmo corpo ⇒ nada muda; corpo novo ⇒
// chunks são refeitos (os antigos são apagados antes).
import { toPgVector, type DocType, type SourceTier } from "@actually/db";
import { chunkText } from "../lib/chunker";
import type { Ctx } from "../lib/ctx";
import { embedDocuments, hasEmbeddingKey } from "../lib/embed";

export const DOC_TYPES: DocType[] = ["programa", "entrevista", "discurso", "debate", "lei", "votacao", "noticia", "dado", "outro"];

export interface DocumentInput {
  url: string;
  title: string;
  doc_type: DocType;
  person: string | null;
  source_name: string;
  tier: SourceTier;
  published_at: string | null;
  topics: string[];
  body: string;
}

export interface IngestDocOpts {
  skipEmbed?: boolean;
  /** Reescreve mesmo que o corpo não tenha mudado. */
  force?: boolean;
}

export function validateDocument(d: DocumentInput): string | null {
  if (!/^https?:\/\//i.test(d.url)) return "url precisa ser http(s) (kb_documents.url)";
  if (!DOC_TYPES.includes(d.doc_type)) return `doc_type inválido: ${d.doc_type}`;
  if (!d.title.trim()) return "título vazio";
  if (d.body.trim().length < 50) return "corpo vazio ou curto demais";
  if (![1, 2, 3, 4].includes(d.tier)) return `tier inválido: ${d.tier}`;
  return null;
}

export async function ingestDocument(ctx: Ctx, d: DocumentInput, opts: IngestDocOpts = {}): Promise<"skipped" | "written" | "dry-run"> {
  const problem = validateDocument(d);
  if (problem) throw new Error(`${d.url}: ${problem}`);
  const chunks = chunkText(d.body);

  if (ctx.dryRun) {
    ctx.log(
      `[dry-run] kb_documents ← ${JSON.stringify({ ...d, body: `${d.body.slice(0, 120)}… (${d.body.length} chars)` })}`,
    );
    ctx.log(`[dry-run] kb_chunks ← ${chunks.length} chunks (${chunks.map((c) => c.text.length).join(", ")} chars)`);
    if (ctx.verbose) for (const c of chunks.slice(0, 2)) ctx.log(`   #${c.index}: ${c.text.slice(0, 200)}…`);
    return "dry-run";
  }
  const db = ctx.db!;
  const { data: existing, error: e0 } = await db.from("kb_documents").select("id, body").eq("url", d.url).maybeSingle();
  if (e0) throw new Error(`kb_documents: ${e0.message}`);
  if (existing && existing.body === d.body && !opts.force) {
    // metadados podem ter mudado no manifesto; atualiza sem refazer chunks
    const { error } = await db
      .from("kb_documents")
      .update({ title: d.title, doc_type: d.doc_type, person: d.person, source_name: d.source_name, tier: d.tier, published_at: d.published_at, topics: d.topics })
      .eq("id", existing.id);
    if (error) throw new Error(`kb_documents: ${error.message}`);
    return "skipped";
  }
  const { data: doc, error: e1 } = await db.from("kb_documents").upsert(d, { onConflict: "url" }).select("id").single();
  if (e1 || !doc) throw new Error(`kb_documents: ${e1?.message ?? "sem id"}`);

  let vectors: (string | null)[] = chunks.map(() => null);
  if (!opts.skipEmbed && hasEmbeddingKey()) {
    vectors = (await embedDocuments(chunks.map((c) => c.text), ctx.log)).map(toPgVector);
  }
  const { error: e2 } = await db.from("kb_chunks").delete().eq("document_id", doc.id);
  if (e2) throw new Error(`kb_chunks (delete): ${e2.message}`);
  const rows = chunks.map((c, i) => ({ document_id: doc.id, chunk_index: c.index, text: c.text, embedding: vectors[i] }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("kb_chunks").insert(rows.slice(i, i + 200));
    if (error) throw new Error(`kb_chunks: ${error.message}`);
  }
  ctx.log(`  ${d.url}: ${chunks.length} chunks${vectors[0] ? " com embeddings" : " (sem embeddings)"}`);
  return "written";
}
