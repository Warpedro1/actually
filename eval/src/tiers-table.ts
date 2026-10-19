// Gera a tabela de fontes/tiers de docs/metodologia.md a partir de SOURCE_TIERS.
// pnpm --filter @actually/eval tiers-table  → imprime o bloco; cole entre os marcadores.
// O teste test/docs.test.ts falha se o doc ficar desatualizado.
import { SOURCE_TIERS, type SourceTierRow } from "@actually/db";

export const BEGIN = "<!-- tiers:begin (gerado por `pnpm --filter @actually/eval tiers-table`; não edite à mão) -->";
export const END = "<!-- tiers:end -->";

const KIND: Record<SourceTierRow["kind"], string> = {
  oficial: "oficial",
  checagem: "checagem",
  imprensa: "imprensa",
  academico: "acadêmico",
  campanha: "campanha",
  outro: "outro",
};

const TIER_DESC: Record<number, string> = {
  1: "Dado oficial primário ou checagem profissional",
  2: "Imprensa de referência ou academia",
  3: "Imprensa geral",
  4: "Qualquer outra fonte",
};

export function renderTiersTable(rows: SourceTierRow[] = SOURCE_TIERS): string {
  const sorted = [...rows].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name, "pt-BR") || a.domain.localeCompare(b.domain));
  const lines = [BEGIN, "", "| Tier | Fonte | Domínio | Tipo |", "| --- | --- | --- | --- |"];
  for (const r of sorted) lines.push(`| ${r.tier} | ${r.name} | \`${r.domain}\` | ${KIND[r.kind]} |`);
  lines.push("");
  const counts = [1, 2, 3, 4].map((t) => `tier ${t} (${TIER_DESC[t]}): ${rows.filter((r) => r.tier === t).length}`);
  lines.push(`Total: ${rows.length} domínios — ${counts.join("; ")}. Domínio fora da lista = tier 4.`);
  lines.push("", END);
  return lines.join("\n");
}

/** Recorta o bloco gerado de um markdown (null se não houver marcadores). */
export function extractBlock(md: string): string | null {
  const i = md.indexOf(BEGIN);
  const j = md.indexOf(END);
  return i === -1 || j === -1 ? null : md.slice(i, j + END.length);
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(renderTiersTable());
