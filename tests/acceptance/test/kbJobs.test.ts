// RF15 (carga da base pelo /admin): fila kb_jobs no banco real (PGlite).
// Editor só lê; escrita e kb_job_claim só pelo service role; uma tarefa por vez.
import { beforeEach, describe, expect, it } from "vitest";
import { asRole, freshDb, one, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const EDITOR = "00000000-0000-4000-8000-0000000000c1";
const STRANGER = "00000000-0000-4000-8000-0000000000c2";

async function seedUsers() {
  await db.query(`insert into auth.users (id) values ($1), ($2)`, [EDITOR, STRANGER]);
  await db.query(`insert into editors (user_id, name) values ($1, 'Editor')`, [EDITOR]);
}

async function newJob(title = "t"): Promise<string> {
  return (await one<{ id: string }>(db,
    `insert into kb_jobs (preset, title, steps) values ('fontes', $1, '[{"kind":"tiers"}]') returning id`, [title])).id;
}

async function claim(owner: string, leaseS = 300): Promise<{ id: string; status: string; lease_owner: string }[]> {
  return (await db.query<{ id: string; status: string; lease_owner: string }>(
    `select id, status, lease_owner from kb_job_claim($1, $2)`, [owner, leaseS])).rows;
}

describe("[RF15] fila de carga da base (kb_jobs)", () => {
  it("[RF15] editor lê as tarefas; anônimo e usuário comum não veem nada", async () => {
    await seedUsers();
    await newJob();
    const editorRows = await asRole(db, "authenticated", EDITOR, async () => (await db.query(`select id from kb_jobs`)).rows.length);
    const strangerRows = await asRole(db, "authenticated", STRANGER, async () => (await db.query(`select id from kb_jobs`)).rows.length);
    const anonRows = await asRole(db, "anon", null, async () => (await db.query(`select id from kb_jobs`)).rows.length);
    expect(editorRows).toBe(1);
    expect(strangerRows).toBe(0);
    expect(anonRows).toBe(0);
  });

  it("[RNF05] [RF15] nem editor escreve direto na fila: criar/cancelar só pela API (service role)", async () => {
    await seedUsers();
    const id = await newJob();
    await asRole(db, "authenticated", EDITOR, async () => {
      await expect(db.query(`insert into kb_jobs (preset, title) values ('fontes', 'x')`)).rejects.toThrow();
      const updated = (await db.query(`update kb_jobs set status = 'canceled' where id = $1 returning id`, [id])).rows.length;
      expect(updated).toBe(0);
    });
    expect((await one<{ status: string }>(db, `select status from kb_jobs where id = $1`, [id])).status).toBe("queued");
  });

  it("[RNF05] [RF15] kb_job_claim não é executável por anon nem por usuário logado", async () => {
    await seedUsers();
    await newJob();
    for (const [role, user] of [["anon", null], ["authenticated", EDITOR]] as const) {
      await asRole(db, role, user, async () => {
        await expect(db.query(`select * from kb_job_claim('x', 60)`)).rejects.toThrow(/permission denied/);
      });
    }
  });

  it("[RF15] uma tarefa por vez, em ordem de criação; lease vencido é retomado", async () => {
    const a = await newJob("a");
    await new Promise((r) => setTimeout(r, 5));
    const b = await newJob("b");

    const first = await claim("run-1");
    expect(first).toEqual([{ id: a, status: "running", lease_owner: "run-1" }]);
    // outra invocação com o lease de "a" ainda válido não pega nem "b"
    expect(await claim("run-2")).toEqual([]);

    // a função morreu: lease vencido ⇒ a próxima chamada retoma a MESMA tarefa
    await db.query(`update kb_jobs set lease_until = now() - interval '1 second' where id = $1`, [a]);
    expect((await claim("run-3"))[0]).toMatchObject({ id: a, lease_owner: "run-3" });

    // concluída, a fila anda
    await db.query(`update kb_jobs set status = 'done', lease_until = null where id = $1`, [a]);
    expect((await claim("run-4"))[0]).toMatchObject({ id: b });
  });

  it("[RF15] tarefa cancelada ou concluída não é pega de novo", async () => {
    const a = await newJob();
    await db.query(`update kb_jobs set status = 'canceled' where id = $1`, [a]);
    expect(await claim("run-1")).toEqual([]);
  });
});
