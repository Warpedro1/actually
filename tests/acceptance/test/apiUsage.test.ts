// Uso das APIs (migration 20261021000010): o sistema soma o que gasta em cada
// API por hora; só o service role grava e lê (nem editor acessa direto).
import { beforeEach, describe, expect, it } from "vitest";
import { asRole, freshDb, one, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const EDITOR = "00000000-0000-4000-8000-0000000000e9";

const add = (rows: unknown[], ratelimits: unknown = {}) =>
  db.query(`select api_usage_add($1::jsonb, $2::jsonb)`, [JSON.stringify(rows), JSON.stringify(ratelimits)]);

describe("[RNF05] uso das APIs (api_usage)", () => {
  it("[RNF05] soma na hora corrente, inclusive linhas repetidas na mesma chamada", async () => {
    await add([
      { provider: "anthropic", model: "claude-haiku-5-5", requests: 2, input_tokens: 1000, output_tokens: 200, cost_usd: 0.0002 },
      { provider: "anthropic", model: "claude-haiku-5-5", requests: 1, input_tokens: 500, output_tokens: 100, cost_usd: 0.0001 },
      { provider: "tavily", units: 1, requests: 1 },
    ]);
    await add([{ provider: "anthropic", model: "claude-haiku-5-5", requests: 1, input_tokens: 10, output_tokens: 1 }]);
    const r = await one<{ requests: number; input_tokens: string; cost_usd: string; n: string }>(db,
      `select requests, input_tokens::text, cost_usd::text, (select count(*) from api_usage)::text as n
       from api_usage where provider = 'anthropic'`);
    expect(r).toMatchObject({ requests: 4, input_tokens: "1510", n: "2" });
    expect(Number(r.cost_usd)).toBeCloseTo(0.0003, 8);
  });

  it("[RNF05] resumo por janela e último retrato de limites", async () => {
    await add([{ provider: "voyage", model: "voyage-3.5", requests: 3, input_tokens: 900 }], {
      anthropic: { "anthropic-ratelimit-requests-remaining": "49" },
    });
    await add([], { anthropic: { "anthropic-ratelimit-requests-remaining": "48" } });
    const s = (await one<{ s: { usage: { provider: string; janela: string; requests: number }[]; ratelimits: Record<string, { headers: Record<string, string> }> } }>(db,
      `select api_usage_summary() as s`)).s;
    const voyage = s.usage.filter((u) => u.provider === "voyage").map((u) => u.janela).sort();
    expect(voyage).toEqual(["24h", "hoje", "hora", "mes"]);
    expect(s.ratelimits.anthropic!.headers["anthropic-ratelimit-requests-remaining"]).toBe("48");
  });

  it("[RNF05] anon e editor não leem as tabelas nem executam as funções", async () => {
    await db.query(`insert into auth.users (id) values ($1)`, [EDITOR]);
    await db.query(`insert into editors (user_id, name) values ($1, 'Editor')`, [EDITOR]);
    await add([{ provider: "apify", units: 1 }]);
    for (const [role, user] of [["anon", null], ["authenticated", EDITOR]] as const) {
      await asRole(db, role, user, async () => {
        expect((await db.query(`select * from api_usage`)).rows).toHaveLength(0);
        expect((await db.query(`select * from api_ratelimits`)).rows).toHaveLength(0);
        for (const fn of [`api_usage_add('[]'::jsonb, '{}'::jsonb)`, `api_usage_summary()`, `ops_db_size()`]) {
          await expect(db.query(`select ${fn}`)).rejects.toThrow(/permission denied/);
        }
      });
    }
  });

  it("[RNF05] ops_db_size devolve o tamanho do banco e as maiores tabelas", async () => {
    const s = (await one<{ s: { db_bytes: number; tables: { table: string; bytes: number }[] } }>(db, `select ops_db_size() as s`)).s;
    expect(s.db_bytes).toBeGreaterThan(0);
    expect(s.tables.length).toBeGreaterThan(0);
  });
});
