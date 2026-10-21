// Contagem do uso das APIs pela carga da base (painel "Uso das APIs" do /admin).
// Acumula em memória e grava em `api_usage` (RPC api_usage_add) ao fim de cada
// etapa (painel) ou do comando (CLI). Falha ao gravar nunca derruba a carga.
import type { ApiUsageRow } from "@actually/db";
import type { Db } from "./ctx";

let pending: ApiUsageRow[] = [];

export function recordUsage(row: ApiUsageRow): void {
  pending.push(row);
}

/** Devolve e zera o acumulado. */
export function drainUsage(): ApiUsageRow[] {
  const out = pending;
  pending = [];
  return out;
}

/** Grava o acumulado. `getDb` só é chamado se houver o que gravar. */
export async function flushUsage(getDb: () => Db | null | undefined, warn?: (...a: unknown[]) => void): Promise<void> {
  if (!pending.length) return;
  const rows = drainUsage();
  try {
    const db = getDb();
    if (!db) return;
    const { error } = await db.rpc("api_usage_add", { p_rows: rows, p_ratelimits: {} });
    if (error) throw new Error(error.message);
  } catch (e) {
    warn?.(`uso das APIs não registrado: ${(e as Error).message}`);
  }
}
