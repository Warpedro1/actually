// Debate de teste (migration 20261020000009): o público não vê nada dele
// (RLS) e os vereditos dele não atravessam para outros debates na trava de
// repetição. A marca é reversível nos dois sentidos.
import { beforeEach, describe, expect, it } from "vitest";
import { addEvidence, asRole, freshDb, insertAlert, one, seedVerification, vec, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const EDITOR = "00000000-0000-4000-8000-0000000000d1";

/** Debate com alerta publicado (evidência verificada), voz mapeada e uma retirada registrada. */
async function publishedDebate(isTest: boolean) {
  const s = await seedVerification(db);
  await db.query(`update debates set is_test = $2 where id = $1`, [s.debate, isTest]);
  await addEvidence(db, s.verification, true);
  const alert = await insertAlert(db, s, "published");
  await db.query(`insert into speaker_map (debate_id, speaker_label, person) values ($1, 'S0', 'Fulano')`, [s.debate]);
  // um segundo alerta só para registrar uma retirada pública
  const extra = await seedVerification(db);
  await db.query(`insert into alert_retractions (alert_id, debate_id) values ($1, $2)`, [
    await insertAlert(db, { debate: s.debate, claim: extra.claim, verification: extra.verification }, "pending_review"),
    s.debate,
  ]);
  return { ...s, alert };
}

/** O que um papel enxerga de um debate, tabela por tabela. */
async function visible(debate: string, verification: string) {
  const n = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows.length;
  return {
    debates: await n(`select id from debates where id = $1`, [debate]),
    alerts: await n(`select id from alerts where debate_id = $1`, [debate]),
    segments: await n(`select id from segments where debate_id = $1`, [debate]),
    speaker_map: await n(`select debate_id from speaker_map where debate_id = $1`, [debate]),
    retractions: await n(`select alert_id from alert_retractions where debate_id = $1`, [debate]),
    verifications: await n(`select id from verifications where id = $1`, [verification]),
    evidence: await n(`select id from evidence where verification_id = $1`, [verification]),
  };
}

const NOTHING = { debates: 0, alerts: 0, segments: 0, speaker_map: 0, retractions: 0, verifications: 0, evidence: 0 };

describe("[RNF05] debate de teste: só editores veem", () => {
  it("[RNF05] anônimo não vê debate de teste nem nada ligado a ele; editor vê tudo", async () => {
    await db.query(`insert into auth.users (id) values ($1)`, [EDITOR]);
    await db.query(`insert into editors (user_id, name) values ($1, 'Editor')`, [EDITOR]);
    const t = await publishedDebate(true);

    expect(await asRole(db, "anon", null, () => visible(t.debate, t.verification))).toEqual(NOTHING);
    const editor = await asRole(db, "authenticated", EDITOR, () => visible(t.debate, t.verification));
    for (const [k, v] of Object.entries(editor)) expect(v, k).toBeGreaterThan(0);
  });

  it("[RNF05] a marca é reversível: desmarcar publica, marcar esconde de novo", async () => {
    const t = await publishedDebate(true);
    await db.query(`update debates set is_test = false where id = $1`, [t.debate]);
    const pub = await asRole(db, "anon", null, () => visible(t.debate, t.verification));
    expect(pub).toMatchObject({ debates: 1, alerts: 1, segments: 1, speaker_map: 1, retractions: 1, verifications: 1, evidence: 1 });

    await db.query(`update debates set is_test = true where id = $1`, [t.debate]);
    expect(await asRole(db, "anon", null, () => visible(t.debate, t.verification))).toEqual(NOTHING);
  });

  it("[RNF05] debate novo nasce público no banco (o /admin é que marca teste por padrão)", async () => {
    const d = await one<{ is_test: boolean }>(db, `insert into debates (slug, title) values ('x', 'X') returning is_test`);
    expect(d.is_test).toBe(false);
  });
});

describe("[RF06] trava de repetição não atravessa debate de teste", () => {
  const match = async (debateId: string) =>
    (await db.query<{ claim_id: string }>(`select claim_id from match_verified_claims($1, $2::vector, 0.9, 5)`, [debateId, vec(1)])).rows.map(
      (r) => r.claim_id,
    );

  it("[RF06] alerta publicado num ensaio não é reaproveitado pelo debate real; no próprio ensaio, sim", async () => {
    const ensaio = await publishedDebate(true);
    const real = await seedVerification(db);
    expect(await match(real.debate)).not.toContain(ensaio.claim);
    expect(await match(ensaio.debate)).toContain(ensaio.claim);
  });

  it("[RF06] ensaio pode reaproveitar veredito de debate real; um ensaio não herda de outro", async () => {
    const real = await publishedDebate(false);
    const ensaio1 = await publishedDebate(true);
    const ensaio2 = await seedVerification(db);
    await db.query(`update debates set is_test = true where id = $1`, [ensaio2.debate]);
    const got = await match(ensaio2.debate);
    expect(got).toContain(real.claim);
    expect(got).not.toContain(ensaio1.claim);
  });

  it("[RF06] desmarcar o teste passa a compartilhar os vereditos dele", async () => {
    const ensaio = await publishedDebate(true);
    const outro = await seedVerification(db);
    expect(await match(outro.debate)).not.toContain(ensaio.claim);
    await db.query(`update debates set is_test = false where id = $1`, [ensaio.debate]);
    expect(await match(outro.debate)).toContain(ensaio.claim);
  });
});
