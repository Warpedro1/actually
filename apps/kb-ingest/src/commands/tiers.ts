// tiers: SOURCE_TIERS (packages/db) → tabela source_tiers.
import { SOURCE_TIERS } from "@actually/db";
import { upsertRows, type Ctx } from "../lib/ctx";

export async function runTiers(ctx: Ctx): Promise<void> {
  const rows = SOURCE_TIERS.map((t) => ({ domain: t.domain, name: t.name, tier: t.tier, kind: t.kind }));
  const n = await upsertRows(ctx, "source_tiers", rows, "domain", { showRows: ctx.verbose ? rows.length : 5 });
  ctx.log(`source_tiers: ${n} domínios sincronizados`);
}
