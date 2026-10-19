// Retirada de alerta publicado (runbook: "Alerta errado publicado").
// Garantias do banco: a retirada vale por qualquer caminho, leva junto as
// repetições, sai da leitura pública e deixa só um sinal com ids para quem já
// está com o /ao-vivo aberto.
import { beforeEach, describe, expect, it } from "vitest";
import { addEvidence, asRole, freshDb, insertAlert, one, seedVerification, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const EDITOR = "00000000-0000-4000-8000-000000000001";
const STRANGER = "00000000-0000-4000-8000-000000000002";

async function makeEditor() {
  await db.query(`insert into auth.users (id) values ($1), ($2)`, [EDITOR, STRANGER]);
  await db.query(`insert into editors (user_id, name) values ($1, 'Editor')`, [EDITOR]);
}

type Seed = Awaited<ReturnType<typeof seedVerification>>;

/** Repetição do alerta `original` (mesma verificação), como o pipeline cria. */
async function insertRepeat(s: Seed, original: string, status: string) {
  return (await one<{ id: string }>(
    db, `insert into alerts (debate_id, claim_id, verification_id, verdict, status, claim_text, summary, correction, is_repeat, repeat_of)
         values ($1, $2, $3, 'contradito', $4, 'afirmação repetida', 'resumo', 'correção', true, $5) returning id`,
    [s.debate, s.claim, s.verification, status, original])).id;
}

/** O que o botão "Retirar" do /editor faz. */
function retract(user: string, id: string, reason = "fonte não sustenta a correção") {
  return asRole(db, "authenticated", user, () => db.query<{ id: string }>(
    `update alerts set status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now()
     where id = $1 and status = 'published' returning id`, [id, reason, user]));
}

const statusOf = async (id: string) =>
  (await one<{ status: string; reject_reason: string | null }>(db, `select status, reject_reason from alerts where id = $1`, [id]));

async function publishedWithRepeats() {
  await makeEditor();
  const s = await seedVerification(db);
  await addEvidence(db, s.verification, true);
  const original = await insertAlert(db, s, "published");
  const repeat1 = await insertRepeat(s, original, "published");
  const repeat2 = await insertRepeat(s, original, "published");
  return { s, original, repeats: [repeat1, repeat2] };
}

describe("[RF08] retirada de alerta publicado (revisão posterior)", () => {
  it("[RF08] editor retira o original e as repetições saem junto (cascata no banco)", async () => {
    const { original, repeats } = await publishedWithRepeats();
    const res = await retract(EDITOR, original);
    expect(res.rows).toHaveLength(1);
    expect((await statusOf(original)).status).toBe("rejected");
    for (const r of repeats) {
      const row = await statusOf(r);
      expect(row.status).toBe("rejected");
      expect(row.reject_reason).toMatch(/original.*fonte não sustenta a correção/);
    }
  });

  it("[RF08] cascata vale por qualquer caminho (SQL direto do service role)", async () => {
    const { original, repeats } = await publishedWithRepeats();
    await db.query(`update alerts set status = 'rejected' where id = $1`, [original]);
    for (const r of repeats) expect((await statusOf(r)).status).toBe("rejected");
  });

  it("[RF08] rejeitar um pendente rejeita as repetições pendentes (não sobram na fila)", async () => {
    await makeEditor();
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, true);
    const original = await insertAlert(db, s, "pending_review");
    const repeat = await insertRepeat(s, original, "pending_review");
    await asRole(db, "authenticated", EDITOR, () =>
      db.query(`update alerts set status = 'rejected', reject_reason = 'expirado' where id = $1`, [original]));
    expect((await statusOf(repeat)).status).toBe("rejected");
    // Nunca estiveram no ar: nenhum sinal público.
    const sig = await one<{ n: number }>(db, `select count(*)::int as n from alert_retractions`);
    expect(sig.n).toBe(0);
  });

  it("[RF08] repetição criada depois da retirada (corrida com o pipeline) já nasce rejeitada", async () => {
    const { s, original } = await publishedWithRepeats();
    await retract(EDITOR, original);
    const late = await insertRepeat(s, original, "published");
    const row = await statusOf(late);
    expect(row.status).toBe("rejected");
    expect(row.reject_reason).toMatch(/original/);
  });

  it("[RF08] repetição não volta ao ar com o original retirado", async () => {
    const { original, repeats } = await publishedWithRepeats();
    await retract(EDITOR, original);
    await expect(db.query(`update alerts set status = 'published' where id = $1`, [repeats[0]])).rejects.toThrow(/original/);
    expect((await statusOf(repeats[0]!)).status).toBe("rejected");
  });

  it("[RF08] retirar só uma repetição não mexe no original", async () => {
    const { original, repeats } = await publishedWithRepeats();
    await retract(EDITOR, repeats[0]!);
    expect((await statusOf(original)).status).toBe("published");
    expect((await statusOf(repeats[1]!)).status).toBe("published");
  });

  it("[RF14] quem não é editor não retira", async () => {
    const { original } = await publishedWithRepeats();
    const res = await retract(STRANGER, original);
    expect(res.rows).toHaveLength(0);
    expect((await statusOf(original)).status).toBe("published");
  });
});

describe("[RNF05] retirado some da leitura pública; só o sinal (ids) é público", () => {
  it("[RNF05] anon deixa de ler o alerta, as repetições e as evidências", async () => {
    const { original } = await publishedWithRepeats();
    const before = await asRole(db, "anon", null, () => db.query(`select id from alerts`));
    expect(before.rows).toHaveLength(3);
    await retract(EDITOR, original);
    const after = await asRole(db, "anon", null, async () => ({
      alerts: (await db.query(`select id from alerts`)).rows,
      evidence: (await db.query(`select id from evidence`)).rows,
    }));
    expect(after.alerts).toHaveLength(0);
    expect(after.evidence).toHaveLength(0);
  });

  it("[RNF05] anon lê alert_retractions com os ids do original e das repetições, e nada do texto", async () => {
    const { s, original, repeats } = await publishedWithRepeats();
    await retract(EDITOR, original);
    const sig = await asRole(db, "anon", null, () =>
      db.query<Record<string, unknown>>(`select * from alert_retractions where debate_id = $1`, [s.debate]));
    expect(sig.rows.map((r) => r.alert_id).sort()).toEqual([original, ...repeats].sort());
    expect(Object.keys(sig.rows[0]!).sort()).toEqual(["alert_id", "debate_id", "retracted_at"]);
  });

  it("[RNF05] público e editor não escrevem no sinal; ele é append-only", async () => {
    const { s, original } = await publishedWithRepeats();
    await expect(asRole(db, "anon", null, () =>
      db.query(`insert into alert_retractions (alert_id, debate_id) values ($1, $2)`, [original, s.debate]))).rejects.toThrow();
    await expect(asRole(db, "authenticated", EDITOR, () =>
      db.query(`insert into alert_retractions (alert_id, debate_id) values ($1, $2)`, [original, s.debate]))).rejects.toThrow();
    await retract(EDITOR, original);
    await expect(db.query(`delete from alert_retractions`)).rejects.toThrow(/append-only/);
    await expect(db.query(`update alert_retractions set retracted_at = now()`)).rejects.toThrow(/append-only/);
  });

  it("[RNF05] sinal está na publicação do Realtime", async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'alert_retractions'`);
    expect(r.rows).toHaveLength(1);
  });
});

describe("[RF16] retirada na auditoria", () => {
  it("[RF16] original e repetições ganham evento published->rejected com o autor da retirada", async () => {
    const { original, repeats } = await publishedWithRepeats();
    await retract(EDITOR, original);
    const ev = await db.query<{ alert_id: string; action: string; actor: string | null }>(
      `select alert_id, action, actor from alert_events where action = 'updated:published->rejected'`);
    expect(ev.rows.map((r) => r.alert_id).sort()).toEqual([original, ...repeats].sort());
    expect(ev.rows.every((r) => r.actor === EDITOR)).toBe(true);
  });
});
