// status: quanto a base cobre — contagens por tabela, fonte, pessoa, tópico e série.
import { requireDb, selectAll, type Ctx, type Db } from "../lib/ctx";
import { CATALOG, type CatalogSeries } from "../indicators/catalog";
import { AGGREGATION_MIGRATION } from "./indicators";

async function count(db: Db, table: string, filter?: (q: any) => any): Promise<number> {
  let q = db.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

export function tally<T>(rows: T[], key: (r: T) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r) ?? "(vazio)";
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

type SeriesRow = { code: string; aliases: string[]; aggregation: string | null };

/**
 * Estado de uma série do catálogo no banco. A L2 cala em série sem agregação (linha anterior à
 * coluna) e usa os aliases que estão no banco: os dois só se acertam rodando `indicators`.
 */
export function seriesState(s: CatalogSeries, row: SeriesRow | undefined): string {
  if (s.pending) return "PENDENTE";
  if (!row) return "não carregada";
  if (row.aggregation == null) return "SEM AGREGAÇÃO";
  const sameAliases = [...row.aliases].sort().join("|") === [...s.aliases].sort().join("|");
  return row.aggregation === s.aggregation && sameAliases ? "carregada" : "DESATUALIZADA";
}

function printTally(ctx: Ctx, title: string, t: [string, number][]) {
  ctx.log(`  ${title}:`);
  for (const [k, n] of t) ctx.log(`    ${String(n).padStart(6)}  ${k}`);
}

export async function runStatus(ctx: Ctx): Promise<void> {
  const db = requireDb(ctx);
  ctx.log(`source_tiers: ${await count(db, "source_tiers")}`);

  const fc = await selectAll<{ source_name: string; verdict: string; person: string | null; topic: string | null }>(
    db, "kb_factchecks", "source_name, verdict, person, topic",
  );
  ctx.log(`\nkb_factchecks (L1): ${fc.length} — sem embedding: ${await count(db, "kb_factchecks", (q) => q.is("embedding", null))}`);
  printTally(ctx, "por fonte", tally(fc, (r) => r.source_name));
  printTally(ctx, "por veredito", tally(fc, (r) => r.verdict));
  printTally(ctx, "por pessoa", tally(fc, (r) => r.person));
  printTally(ctx, "por tópico", tally(fc, (r) => r.topic));

  let series: SeriesRow[];
  try {
    series = await selectAll<SeriesRow>(db, "indicator_series", "code, aliases, aggregation");
  } catch (e) {
    ctx.warn(`indicator_series sem a coluna aggregation (${(e as Error).message}): aplique ${AGGREGATION_MIGRATION}`);
    series = (await selectAll<Omit<SeriesRow, "aggregation">>(db, "indicator_series", "code, aliases")).map((r) => ({ ...r, aggregation: null }));
  }
  const values = await selectAll<{ series_code: string; period_end: string }>(db, "indicator_values", "series_code, period_end");
  ctx.log(`\nindicator_series (L2): ${series.length} — indicator_values: ${values.length}`);
  let stale = 0;
  for (const s of CATALOG) {
    const v = values.filter((x) => x.series_code === s.code);
    const last = v.map((x) => x.period_end).sort().at(-1);
    const state = seriesState(s, series.find((x) => x.code === s.code));
    if (state === "SEM AGREGAÇÃO" || state === "DESATUALIZADA") stale++;
    ctx.log(`    ${s.code.padEnd(30)} ${state.padEnd(14)} ${String(v.length).padStart(5)} valores${last ? `, até ${last}` : ""}`);
  }
  if (stale) ctx.warn(`${stale} série(s) sem agregação ou diferentes do catálogo: a L2 cala nelas ou usa aliases antigos — rode \`indicators\``);

  const docs = await selectAll<{ doc_type: string; person: string | null; source_name: string; topics: string[] }>(
    db, "kb_documents", "doc_type, person, source_name, topics",
  );
  ctx.log(
    `\nkb_documents (L3): ${docs.length} — kb_chunks: ${await count(db, "kb_chunks")}, sem embedding: ${await count(db, "kb_chunks", (q) => q.is("embedding", null))}`,
  );
  printTally(ctx, "por tipo", tally(docs, (r) => r.doc_type));
  printTally(ctx, "por pessoa", tally(docs, (r) => r.person));
  printTally(ctx, "por fonte", tally(docs, (r) => r.source_name));
  printTally(ctx, "por tópico", tally(docs.flatMap((d) => (d.topics.length ? d.topics : [null])), (t) => t));
}
