// L2 no banco: a coluna indicator_series.aggregation (migration 20261019000007) existe,
// aceita exatamente os valores de INDICATOR_AGGREGATIONS, recebe as linhas que o
// kb-ingest grava e volta pelo find_indicator — o pipeline lê dali como agregar a série.
import { INDICATOR_AGGREGATIONS } from "@actually/db";
import { beforeEach, describe, expect, it } from "vitest";
import { activeSeries, toSeriesRow } from "../../../apps/kb-ingest/src/indicators/catalog";
import { asRole, freshDb, one, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

async function insertSeries(row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db.query(
    `insert into indicator_series (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
    cols.map((c) => row[c]),
  );
}

const base = (code: string) => ({
  code, name: `Série ${code}`, aliases: [code], unit: "%", periodicity: "monthly",
  source_name: "IBGE", source_url: "https://sidra.ibge.gov.br/", tier: 1, notes: null,
});

describe("[RF15] indicator_series.aggregation (L2)", () => {
  it("[RF15] toda linha que o kb-ingest grava cabe no schema real e o find_indicator devolve a agregação", async () => {
    // a falha original: o kb-ingest mandava `aggregation` para um banco sem a coluna e a carga parava
    for (const s of activeSeries()) await insertSeries(toSeriesRow(s) as unknown as Record<string, unknown>);
    for (const s of activeSeries()) {
      const m = await one<{ code: string; aggregation: string | null; score: number }>(
        db, `select * from find_indicator($1, 1)`, [s.name]);
      expect(m).toMatchObject({ code: s.code, aggregation: s.aggregation });
      expect(m.score).toBeGreaterThan(0.99);
    }
  });

  it("[RF15] o check da coluna aceita exatamente INDICATOR_AGGREGATIONS (@actually/db)", async () => {
    for (const a of INDICATOR_AGGREGATIONS) await insertSeries({ ...base(`s_${a}`), aggregation: a });
    await expect(insertSeries({ ...base("s_soma"), aggregation: "soma" })).rejects.toThrow(/check/);
    await expect(insertSeries({ ...base("s_media"), aggregation: "mean" })).rejects.toThrow(/check/);
  });

  it("[RF15] linha anterior à coluna fica sem agregação (null, nunca 'none') até o próximo `kb-ingest indicators`", async () => {
    await insertSeries(base("antiga"));
    const m = await one<{ aggregation: string | null }>(db, `select aggregation from find_indicator('antiga', 1)`);
    expect(m.aggregation).toBeNull();
  });

  it("[RF15] find_indicator recriado mantém o search_path fixo do hardening", async () => {
    const f = await one<{ cfg: string[] | null }>(
      db, `select proconfig as cfg from pg_proc where proname = 'find_indicator'`);
    expect(f.cfg).toEqual(["search_path=public, extensions"]);
  });

  it("[RNF05] anon e authenticated não leem séries pelo find_indicator (RLS sem políticas)", async () => {
    await insertSeries({ ...base("desemprego"), aggregation: "mean_or_last" });
    for (const role of ["anon", "authenticated"] as const) {
      const rows = await asRole(db, role, null, async () => (await db.query(`select * from find_indicator('desemprego', 5)`)).rows);
      expect(rows).toEqual([]);
    }
  });
});
