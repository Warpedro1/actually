// embed-missing: preenche embeddings nulos em kb_chunks e kb_factchecks.
//   --table kb_chunks|kb_factchecks|all   (padrão all)
//   --max N                               no máximo N linhas por tabela
import { toPgVector } from "@actually/db";
import { requireDb, type Ctx } from "../lib/ctx";
import { embedDocuments } from "../lib/embed";
import { mapLimit } from "../lib/http";

export interface EmbedMissingOpts {
  table?: "kb_chunks" | "kb_factchecks" | "all";
  max?: number;
}

const TARGETS = {
  kb_chunks: { id: "id", text: "text" },
  kb_factchecks: { id: "id", text: "claim_text" },
} as const;

export async function runEmbedMissing(ctx: Ctx, opts: EmbedMissingOpts): Promise<void> {
  const tables = opts.table && opts.table !== "all" ? [opts.table] : (["kb_chunks", "kb_factchecks"] as const);
  if (ctx.dryRun) {
    ctx.log("[dry-run] contaria as linhas com embedding nulo e chamaria a Voyage em lotes; nada gravado");
  }
  const db = ctx.dryRun ? null : requireDb(ctx);
  for (const table of tables) {
    const { id, text } = TARGETS[table];
    let done = 0;
    for (;;) {
      if (!db) break;
      const pageSize = Math.min(256, (opts.max ?? Infinity) - done);
      if (pageSize <= 0) break;
      const { data, error } = await db.from(table).select(`${id}, ${text}`).is("embedding", null).order(id).limit(pageSize);
      if (error) throw new Error(`${table}: ${error.message}`);
      const rows = (data ?? []) as unknown as Record<string, string | number>[];
      if (!rows.length) break;
      const vectors = await embedDocuments(rows.map((r) => String(r[text])), ctx.log);
      await mapLimit(rows, 4, async (r, i) => {
        const { error: e } = await db.from(table).update({ embedding: toPgVector(vectors[i]!) }).eq(id, r[id]!);
        if (e) throw new Error(`${table} ${r[id]}: ${e.message}`);
      });
      done += rows.length;
      ctx.log(`${table}: ${done} embeddings preenchidos`);
    }
    ctx.log(`${table}: concluído (${done})`);
  }
}
