// Contexto de execução: banco (ou modo seco) e log.
// Em --dry-run nada é gravado e o Supabase nem é instanciado: as escritas são
// impressas (resumidas) para conferência.
import { serviceClient } from "@actually/db";

export type Db = ReturnType<typeof serviceClient>;

export interface Ctx {
  dryRun: boolean;
  verbose: boolean;
  /** null em --dry-run. */
  db: Db | null;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export function makeCtx(opts: { dryRun: boolean; verbose: boolean }): Ctx {
  const log = (...a: unknown[]) => console.log(...a);
  const warn = (...a: unknown[]) => console.warn("⚠", ...a);
  return { ...opts, db: opts.dryRun ? null : serviceClient(), log, warn };
}

/** Banco obrigatório (comandos de leitura como status/embed-missing). */
export function requireDb(ctx: Ctx): Db {
  if (!ctx.db) throw new Error("este comando precisa do banco (SUPABASE_SERVICE_ROLE_KEY) e não tem modo seco útil");
  return ctx.db;
}

function preview(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "embedding" && v) out[k] = `<vector ${String(v).split(",").length}>`;
    else if (typeof v === "string" && v.length > 160) out[k] = `${v.slice(0, 160)}… (${v.length} chars)`;
    else out[k] = v;
  }
  return out;
}

/**
 * Upsert em lotes. Em modo seco imprime a contagem e algumas linhas.
 * `onConflict` = colunas da chave natural (idempotência).
 */
export async function upsertRows(
  ctx: Ctx,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  opts: { batch?: number; showRows?: number } = {},
): Promise<number> {
  if (!rows.length) return 0;
  if (ctx.dryRun) {
    const show = opts.showRows ?? (ctx.verbose ? rows.length : 3);
    ctx.log(`[dry-run] upsert ${table} (${rows.length} linhas, conflito em ${onConflict})`);
    for (const r of rows.slice(0, show)) ctx.log("  ", JSON.stringify(preview(r)));
    if (rows.length > show) ctx.log(`   … +${rows.length - show} linhas`);
    return rows.length;
  }
  const db = ctx.db!;
  const batch = opts.batch ?? 500;
  for (let i = 0; i < rows.length; i += batch) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + batch), { onConflict });
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
  }
  return rows.length;
}

/** Lê todas as linhas (paginando de 1000 em 1000). */
export async function selectAll<T>(db: Db, table: string, columns: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`select ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
