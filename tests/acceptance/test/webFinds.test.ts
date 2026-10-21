// A base aprende com a web (migration 20261021000014): o pipeline grava na fila
// kb_web_finds as páginas que a busca web trouxe; a carga as pega em lotes pela RPC
// kb_web_finds_claim. Só o service role grava, lê e pega da fila.
import { beforeEach, describe, expect, it } from "vitest";
import { asRole, freshDb, one, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const EDITOR = "00000000-0000-4000-8000-0000000000e9";

async function find(url: string, foundAt: string, status = "pending"): Promise<void> {
  await db.query(
    `insert into kb_web_finds (url, title, text, source_name, tier, found_at, status) values ($1, 't', 'texto', 'g1', 2, $2, $3)`,
    [url, foundAt, status],
  );
}

const claim = async (limit: number) =>
  (await db.query<{ url: string; status: string }>(`select url, status from kb_web_finds_claim($1)`, [limit])).rows;

describe("[RF15] [RNF05] fila da web (kb_web_finds)", () => {
  it("[RF15] pega em ordem de chegada, marca 'processing' e não devolve a mesma página duas vezes", async () => {
    await find("https://g1.globo.com/a", "2026-10-22T00:00:01Z");
    await find("https://g1.globo.com/b", "2026-10-22T00:00:02Z");
    await find("https://g1.globo.com/c", "2026-10-22T00:00:03Z");
    await find("https://g1.globo.com/d", "2026-10-22T00:00:00Z", "done");
    expect((await claim(2)).map((r) => [r.url, r.status])).toEqual([
      ["https://g1.globo.com/a", "processing"],
      ["https://g1.globo.com/b", "processing"],
    ]);
    expect((await claim(10)).map((r) => r.url)).toEqual(["https://g1.globo.com/c"]);
    expect(await claim(10)).toEqual([]);
  });

  it("[RF15] página presa em 'processing' há mais de 10 min volta para a fila", async () => {
    await find("https://g1.globo.com/a", "2026-10-22T00:00:01Z", "processing");
    await db.query(`update kb_web_finds set claimed_at = now() - interval '11 minutes'`);
    expect((await claim(5)).map((r) => r.url)).toEqual(["https://g1.globo.com/a"]);
    await db.query(`update kb_web_finds set claimed_at = now() - interval '2 minutes'`);
    expect(await claim(5)).toEqual([]);
  });

  it("[RF15] URL única e só nível 1–2: a mesma página não entra duas vezes", async () => {
    await find("https://g1.globo.com/a", "2026-10-22T00:00:01Z");
    await expect(find("https://g1.globo.com/a", "2026-10-22T00:00:02Z")).rejects.toThrow(/duplicate key/);
    await expect(
      db.query(`insert into kb_web_finds (url, text, source_name, tier) values ('https://blog.x/a', 't', 'x', 4)`),
    ).rejects.toThrow(/check constraint/);
    const r = await one<{ n: string }>(db, `select count(*)::text as n from kb_web_finds`);
    expect(r.n).toBe("1");
  });

  it("[RNF05] anon e editor não leem a fila nem executam a RPC", async () => {
    await db.query(`insert into auth.users (id) values ($1)`, [EDITOR]);
    await db.query(`insert into editors (user_id, name) values ($1, 'Editor')`, [EDITOR]);
    await find("https://g1.globo.com/a", "2026-10-22T00:00:01Z");
    for (const [role, user] of [["anon", null], ["authenticated", EDITOR]] as const) {
      await asRole(db, role, user, async () => {
        await expect(db.query(`select * from kb_web_finds`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`select * from kb_web_finds_claim(5)`)).rejects.toThrow(/permission denied/);
      });
    }
  });

  it("[RF15] origin marca o que veio da web em kb_documents e kb_factchecks", async () => {
    await db.query(
      `insert into kb_documents (url, title, doc_type, source_name, tier, body, origin) values ('https://g1.globo.com/x', 'x', 'noticia', 'g1', 2, 'corpo', 'web')`,
    );
    const r = await one<{ origin: string }>(db, `select origin from kb_documents`);
    expect(r.origin).toBe("web");
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'kb_factchecks' and column_name = 'origin'`,
    );
    expect(cols.rows).toHaveLength(1);
  });
});
