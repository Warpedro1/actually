// RF14: 2FA aplicado no banco. Com editors.mfa_required = true, a senha sozinha
// (JWT aal1) não dá nenhuma permissão de editor pela API; só a sessão
// verificada com TOTP (aal2) dá. Simula o JWT do Supabase via asRole(..., { aal }).
import { beforeEach, describe, expect, it } from "vitest";
import { addEvidence, asRole, freshDb, insertAlert, one, seedVerification, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const EDITOR = "00000000-0000-4000-8000-0000000000e1";
const STRANGER = "00000000-0000-4000-8000-0000000000e2";

async function setup(mfaRequired: boolean) {
  await db.query(`insert into auth.users (id) values ($1), ($2)`, [EDITOR, STRANGER]);
  await db.query(`insert into editors (user_id, name, mfa_required) values ($1, 'Editor', $2)`, [EDITOR, mfaRequired]);
  const s = await seedVerification(db);
  await addEvidence(db, s.verification, true);
  const alert = await insertAlert(db, s, "pending_review");
  const standby = (await one<{ id: string }>(db,
    `insert into capture_agents (debate_id, name, source, role) values ($1, 'reserva', 'device', 'standby') returning id`,
    [s.debate])).id;
  const machine = (await one<{ id: string }>(db, `insert into capture_machines (name) values ('casa') returning id`)).id;
  return { ...s, alert, standby, machine };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

const as = <T>(userId: string, aal: "aal1" | "aal2", fn: () => Promise<T>) =>
  asRole(db, "authenticated", userId, fn, { aal });

/** Tenta, pela API, tudo o que um editor pode fazer; devolve o que passou. */
async function tryEditorActions(f: Fixture) {
  const isEditor = (await one<{ ok: boolean }>(db, `select is_editor() as ok`)).ok;
  const readPending = (await db.query(`select id from alerts where status = 'pending_review'`)).rows.length;
  const published = (await db.query(
    `update alerts set status = 'published', reviewed_by = $2 where id = $1 returning id`, [f.alert, EDITOR])).rows.length;
  const settings = (await db.query(
    `update debates set settings = settings || '{"require_red_approval": false, "t_red": 0}'::jsonb
     where id = $1 returning id`, [f.debate])).rows.length;
  const machine = (await db.query(
    `update capture_machines set desired = '{"state":"running","debate_slug":"x"}' where id = $1 returning id`,
    [f.machine])).rows.length;
  // true se trocou; senão a mensagem de erro (esperada: a checagem de is_editor() da função).
  let switched: true | string = true;
  try {
    await db.query(`select capture_set_active($1)`, [f.standby]);
  } catch (e) {
    switched = (e as Error).message;
  }
  let speakerMap = true;
  try {
    await db.query(`insert into speaker_map (debate_id, speaker_label, person) values ($1, 'S0', 'Fulano')`, [f.debate]);
  } catch {
    speakerMap = false;
  }
  let newDebate = true;
  try {
    await db.query(`insert into debates (slug, title) values ('invasor', 'X')`);
  } catch {
    newDebate = false;
  }
  return { isEditor, readPending, published, settings, machine, switched, speakerMap, newDebate };
}

async function state(f: Fixture) {
  return one<{ status: string; red: boolean; t_red: number; machine: string; active: boolean; speakers: number; debates: number }>(db,
    `select (select status::text from alerts where id = $1) as status,
            (select (settings ->> 'require_red_approval')::boolean from debates where id = $2) as red,
            (select (settings ->> 't_red')::float8 from debates where id = $2) as t_red,
            (select desired ->> 'state' from capture_machines where id = $3) as machine,
            (select active from capture_agents where id = $4) as active,
            (select count(*)::int from speaker_map) as speakers,
            (select count(*)::int from debates) as debates`,
    [f.alert, f.debate, f.machine, f.standby]);
}

const NOTHING = {
  isEditor: false, readPending: 0, published: 0, settings: 0, machine: 0,
  switched: "sem permissão", speakerMap: false, newDebate: false,
};
const EVERYTHING = {
  isEditor: true, readPending: 1, published: 1, settings: 1, machine: 1,
  switched: true, speakerMap: true, newDebate: true,
};

describe("[RF14] 2FA exigido no banco (editors.mfa_required)", () => {
  it("[RF14] com mfa_required, sessão aal1 (só senha) não age como editor pela API", async () => {
    const f = await setup(true);
    const res = await as(EDITOR, "aal1", () => tryEditorActions(f));
    expect(res).toEqual(NOTHING);
    expect(await state(f)).toEqual({
      status: "pending_review", red: true, t_red: 0.85, machine: "stopped", active: false, speakers: 0, debates: 1,
    });
  });

  it("[RF14] com mfa_required, JWT sem a claim aal também é recusado", async () => {
    const f = await setup(true);
    const res = await asRole(db, "authenticated", EDITOR, () => tryEditorActions(f));
    expect(res).toEqual(NOTHING);
  });

  it("[RF14] com mfa_required, sessão aal2 (TOTP verificado) age como editor", async () => {
    const f = await setup(true);
    const res = await as(EDITOR, "aal2", () => tryEditorActions(f));
    expect(res).toEqual(EVERYTHING);
    expect(await state(f)).toEqual({
      status: "published", red: false, t_red: 0, machine: "running", active: true, speakers: 1, debates: 2,
    });
  });

  it("[RF14] editor em aal1 não consegue desmarcar o próprio mfa_required", async () => {
    await setup(true);
    const res = await as(EDITOR, "aal1", () =>
      db.query(`update editors set mfa_required = false where user_id = $1 returning user_id`, [EDITOR]));
    expect(res.rows).toHaveLength(0);
    const row = await one<{ mfa_required: boolean }>(db, `select mfa_required from editors where user_id = $1`, [EDITOR]);
    expect(row.mfa_required).toBe(true);
  });

  it("[RF14] editor ainda vê a própria linha em aal1 (o /editor sabe que falta o 2FA)", async () => {
    await setup(true);
    const res = await as(EDITOR, "aal1", () =>
      db.query<{ mfa_required: boolean }>(`select mfa_required from editors where user_id = $1`, [EDITOR]));
    expect(res.rows).toEqual([{ mfa_required: true }]);
  });

  it("[RF14] sem mfa_required (padrão), aal1 segue com acesso de editor", async () => {
    const f = await setup(false);
    const res = await as(EDITOR, "aal1", () => tryEditorActions(f));
    expect(res).toEqual(EVERYTHING);
  });

  it("[RF14] aal2 não transforma quem não está em editors em editor", async () => {
    const f = await setup(true);
    const res = await as(STRANGER, "aal2", () => tryEditorActions(f));
    expect(res).toEqual(NOTHING);
  });
});
