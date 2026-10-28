// Settings do debate gravadas por patch (RPC set_debate_settings, migration
// 20261019000006_settings_patch.sql): o /admin manda só as chaves alteradas e o
// valor que leu de cada uma; o banco aplica sobre o valor atual.
import { beforeEach, describe, expect, it } from "vitest";
import { asRole, freshDb, one, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const EDITOR = "00000000-0000-4000-8000-000000000001";
const STRANGER = "00000000-0000-4000-8000-000000000002";

async function setup() {
  await db.query(`insert into auth.users (id) values ($1), ($2)`, [EDITOR, STRANGER]);
  await db.query(`insert into editors (user_id, name) values ($1, 'Editor')`, [EDITOR]);
  return (await one<{ id: string }>(db, `insert into debates (slug, title) values ('s', 'S') returning id`)).id;
}

type Settings = Record<string, unknown>;
const read = async (debate: string) => (await one<{ settings: Settings }>(db, `select settings from debates where id = $1`, [debate])).settings;

/** Salva como a aba do /admin: patch + valor lido de cada chave do patch. */
function save(debate: string, readSettings: Settings, patch: Settings, as: { role: "anon" | "authenticated"; user: string | null } = { role: "authenticated", user: EDITOR }) {
  const expected = Object.fromEntries(Object.keys(patch).map((k) => [k, readSettings[k] ?? null]));
  return asRole(db, as.role, as.user, () =>
    db.query<{ s: Settings }>(`select set_debate_settings($1, $2::jsonb, $3::jsonb) as s`, [debate, JSON.stringify(patch), JSON.stringify(expected)]),
  );
}

describe("[RF07] [RF08] settings por patch no banco", () => {
  it("[RF07] dois salvamentos concorrentes de chaves diferentes preservam ambas", async () => {
    const debate = await setup();
    const snapshot = await read(debate); // as duas abas leram o mesmo estado
    await Promise.all([save(debate, snapshot, { t_red: 0.9 }), save(debate, snapshot, { show_attribution: true })]);
    const after = await read(debate);
    expect(after).toMatchObject({ t_red: 0.9, show_attribution: true, require_red_approval: true, t_yellow: 0.75 });
  });

  it("[RF07] busca na web: chave que o banco ainda não tem é gravada, religada, e as outras ficam", async () => {
    const debate = await setup();
    const snapshot = await read(debate);
    expect(snapshot).not.toHaveProperty("web_search"); // debates criados antes da chave
    await save(debate, snapshot, { web_search: false });
    const off = await read(debate);
    expect(off).toMatchObject({ web_search: false, require_red_approval: true, t_red: 0.85 });
    await save(debate, off, { web_search: true });
    expect(await read(debate)).toMatchObject({ web_search: true, require_red_approval: true, t_red: 0.85 });
  });

  it("[RF08] aba obsoleta mexendo em t_red não desliga o HITL ligado depois em outra sessão", async () => {
    const debate = await setup();
    await db.query(`update debates set settings = settings || '{"require_red_approval": false}' where id = $1`, [debate]);
    const stale = await read(debate); // aba aberta às 19h, HITL desligado
    await save(debate, stale, { require_red_approval: true }); // responsável liga às 21h
    await save(debate, stale, { t_red: 0.9 }); // operador na aba antiga, 21:20
    expect(await read(debate)).toMatchObject({ require_red_approval: true, t_red: 0.9 });
  });

  it("[RF08] chave que mudou desde a leitura: 40001 e nada é gravado", async () => {
    const debate = await setup();
    const snapshot = await read(debate);
    await save(debate, snapshot, { require_red_approval: false });
    await expect(save(debate, snapshot, { require_red_approval: true, t_red: 0.95 })).rejects.toMatchObject({
      code: "40001",
      detail: "require_red_approval",
    });
    expect(await read(debate)).toMatchObject({ require_red_approval: false, t_red: 0.85 });
  });

  it("[RF08] patch sem o valor lido de cada chave é recusado", async () => {
    const debate = await setup();
    await expect(
      asRole(db, "authenticated", EDITOR, () =>
        db.query(`select set_debate_settings($1, '{"require_red_approval": false}'::jsonb, '{}'::jsonb)`, [debate]),
      ),
    ).rejects.toMatchObject({ code: "22023" });
    expect(await read(debate)).toMatchObject({ require_red_approval: true });
  });

  it("[RF14] não editor e anon não alteram settings pela RPC", async () => {
    const debate = await setup();
    const snapshot = await read(debate);
    await expect(save(debate, snapshot, { require_red_approval: false }, { role: "authenticated", user: STRANGER })).rejects.toMatchObject({
      code: "42501",
    });
    await expect(save(debate, snapshot, { require_red_approval: false }, { role: "anon", user: null })).rejects.toThrow();
    expect(await read(debate)).toMatchObject({ require_red_approval: true });
  });
});
