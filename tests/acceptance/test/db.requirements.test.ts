// Testes de aceitação dos requisitos garantidos pelo banco (docs/requisitos.md).
// Cada teste leva o ID do requisito no nome: o teste de rastreabilidade exige
// que todo RF/RNF tenha pelo menos um teste marcado.
import { beforeEach, describe, expect, it } from "vitest";
import { addEvidence, asRole, freshDb, insertAlert, one, seedVerification, vec, type Db } from "./db";

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

describe("[RF05] toda correção tem URL e trecho verificado", () => {
  it("[RF05] publicar sem evidência é rejeitado pelo banco", async () => {
    const s = await seedVerification(db);
    await expect(insertAlert(db, s, "published")).rejects.toThrow(/evidência/);
  });

  it("[RF05] evidência com trecho não verificado não basta", async () => {
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, false);
    await expect(insertAlert(db, s, "published")).rejects.toThrow(/evidência/);
  });

  it("[RF05] URL que não é http(s) e trecho vazio são recusados na própria evidência", async () => {
    const s = await seedVerification(db);
    await expect(addEvidence(db, s.verification, true, "javascript:alert(1)")).rejects.toThrow();
    await expect(db.query(
      `insert into evidence (verification_id, evidence_type, url, source_name, source_tier, quote, quote_verified)
       values ($1, 'web', 'https://x.org', 'X', 2, '   ', true)`, [s.verification])).rejects.toThrow();
  });

  it("[RF05] com URL + trecho verificado, publica e preenche published_at", async () => {
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, true);
    const id = await insertAlert(db, s, "published");
    const row = await one<{ published_at: string | null }>(db, `select published_at from alerts where id = $1`, [id]);
    expect(row.published_at).not.toBeNull();
  });

  it("[RF04] alerta só existe para contradito/impreciso, com correção", async () => {
    const s = await seedVerification(db, { verdict: "confirmado" });
    await addEvidence(db, s.verification, true);
    await expect(db.query(
      `insert into alerts (debate_id, claim_id, verification_id, verdict, status, claim_text, summary, correction)
       values ($1, $2, $3, 'confirmado', 'published', 'a', 's', 'c')`, [s.debate, s.claim, s.verification])).rejects.toThrow();
    await expect(db.query(
      `insert into alerts (debate_id, claim_id, verification_id, verdict, status, claim_text, summary)
       values ($1, $2, $3, 'contradito', 'pending_review', 'a', 's')`, [s.debate, s.claim, s.verification])).rejects.toThrow();
  });
});

describe("[RF08] HITL de vermelhos", () => {
  it("[RF08] pendente é invisível para o público e visível para o editor", async () => {
    await makeEditor();
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, true);
    await insertAlert(db, s, "pending_review");
    const anon = await asRole(db, "anon", null, () => db.query(`select id from alerts`));
    expect(anon.rows).toHaveLength(0);
    const editor = await asRole(db, "authenticated", EDITOR, () => db.query(`select id from alerts`));
    expect(editor.rows).toHaveLength(1);
  });

  it("[RF08] aprovação pelo editor também exige evidência verificada", async () => {
    await makeEditor();
    const s = await seedVerification(db);
    const id = await insertAlert(db, s, "pending_review");
    await expect(asRole(db, "authenticated", EDITOR, () =>
      db.query(`update alerts set status = 'published', reviewed_by = $2 where id = $1`, [id, EDITOR]))).rejects.toThrow(/evidência/);
    await addEvidence(db, s.verification, true);
    await asRole(db, "authenticated", EDITOR, () =>
      db.query(`update alerts set status = 'published', reviewed_by = $2 where id = $1`, [id, EDITOR]));
    const anon = await asRole(db, "anon", null, () => db.query(`select id from alerts`));
    expect(anon.rows).toHaveLength(1);
  });

  it("[RF14] usuário autenticado que não é editor não aprova nem lê pendentes", async () => {
    await makeEditor();
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, true);
    const id = await insertAlert(db, s, "pending_review");
    const res = await asRole(db, "authenticated", STRANGER, async () => {
      await db.query(`update alerts set status = 'published' where id = $1`, [id]);
      return db.query(`select id from alerts`);
    });
    expect(res.rows).toHaveLength(0);
    const row = await one<{ status: string }>(db, `select status from alerts where id = $1`, [id]);
    expect(row.status).toBe("pending_review");
  });
});

describe("[RF06] trava de repetição no banco", () => {
  it("[RF06] mesma afirmação (hash) no mesmo debate não vira segundo original", async () => {
    const s = await seedVerification(db);
    const hash = (await one<{ claim_hash: string }>(db, `select claim_hash from claims where id = $1`, [s.claim])).claim_hash;
    await expect(db.query(
      `insert into claims (debate_id, segment_id, text_original, text_normalized, claim_hash)
       values ($1, $2, 'a', 'a', $3)`, [s.debate, s.segment, hash])).rejects.toThrow();
    await db.query(
      `insert into claims (debate_id, segment_id, text_original, text_normalized, claim_hash, duplicate_of)
       values ($1, $2, 'a', 'a', $3, $4)`, [s.debate, s.segment, hash, s.claim]);
  });

  it("[RF06] afirmação semelhante já verificada é encontrada com o veredito", async () => {
    const s = await seedVerification(db);
    const m = await db.query<{ verification_id: string; verdict: string }>(
      `select * from match_verified_claims($1, $2, 0.92)`, [s.debate, vec(0.99)]);
    expect(m.rows[0]?.verification_id).toBe(s.verification);
    expect(m.rows[0]?.verdict).toBe("contradito");
  });
});

describe("[RF12] plano B: failover", () => {
  async function agents() {
    const debate = (await one<{ id: string }>(db, `insert into debates (slug, title) values ('f', 'F') returning id`)).id;
    const primary = (await one<{ id: string }>(db,
      `insert into capture_agents (debate_id, name, source, role) values ($1, 'casa', 'youtube', 'primary') returning id`, [debate])).id;
    const standby = (await one<{ id: string }>(db,
      `insert into capture_agents (debate_id, name, source, role) values ($1, 'reserva', 'device', 'standby') returning id`, [debate])).id;
    return { debate, primary, standby };
  }
  const hb = async (id: string) => (await one<{ a: boolean }>(db, `select capture_heartbeat($1) as a`, [id])).a;

  it("[RF12] só um agente ativo; o standby não rouba de um ativo vivo", async () => {
    const a = await agents();
    expect(await hb(a.primary)).toBe(true);
    expect(await hb(a.standby)).toBe(false);
  });

  it("[RF12] sem heartbeat do ativo por failover_after_s, o standby assume", async () => {
    const a = await agents();
    await hb(a.primary);
    await db.query(`update capture_agents set last_heartbeat = now() - interval '11 seconds' where id = $1`, [a.primary]);
    expect(await hb(a.standby)).toBe(true);
    expect(await hb(a.primary)).toBe(false);
  });

  it("[RF12] troca manual pelo service role (admin)", async () => {
    const a = await agents();
    await hb(a.primary);
    await hb(a.standby);
    await db.query(`select capture_set_active($1)`, [a.standby]);
    expect(await hb(a.standby)).toBe(true);
    expect(await hb(a.primary)).toBe(false);
  });
});

describe("[RF13] controle remoto da captura", () => {
  it("[RF13] máquina nasce parada; desired editado pelo editor registra quem e quando", async () => {
    await makeEditor();
    const m = (await one<{ id: string; desired: { state: string } }>(db,
      `insert into capture_machines (name) values ('casa') returning id, desired`));
    expect(m.desired.state).toBe("stopped");
    await asRole(db, "authenticated", EDITOR, () =>
      db.query(`update capture_machines set desired = '{"state":"running","debate_slug":"x"}' where id = $1`, [m.id]));
    const row = await one<{ desired: { state: string }; desired_updated_by: string }>(db,
      `select desired, desired_updated_by from capture_machines where id = $1`, [m.id]);
    expect(row.desired.state).toBe("running");
    expect(row.desired_updated_by).toBe(EDITOR);
  });

  it("[RF13] público não vê nem altera máquinas", async () => {
    await db.query(`insert into capture_machines (name) values ('casa')`);
    const res = await asRole(db, "anon", null, async () => {
      await db.query(`update capture_machines set desired = '{"state":"running"}'`);
      return db.query(`select * from capture_machines`);
    });
    expect(res.rows).toHaveLength(0);
    const row = await one<{ desired: { state: string } }>(db, `select desired from capture_machines`);
    expect(row.desired.state).toBe("stopped");
  });
});

describe("[RF16] auditoria append-only", () => {
  it("[RF16] segments, verifications, evidence e alert_events não mudam; alerts não são apagados", async () => {
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, true);
    const alert = await insertAlert(db, s, "published");
    await expect(db.query(`update segments set text = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from verifications`)).rejects.toThrow(/append-only/);
    await expect(db.query(`update evidence set quote = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from alert_events`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from alerts where id = $1`, [alert])).rejects.toThrow(/append-only/);
  });

  it("[RF16] criação e mudança de status de alerta geram eventos", async () => {
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, true);
    const id = await insertAlert(db, s, "pending_review");
    await db.query(`update alerts set status = 'published' where id = $1`, [id]);
    const ev = await db.query<{ action: string }>(`select action from alert_events where alert_id = $1 order by id`, [id]);
    expect(ev.rows.map((r) => r.action)).toEqual(["created:pending_review", "updated:pending_review->published"]);
  });
});

describe("[RNF05] segurança", () => {
  it("[RNF05] anon não lê base de conhecimento, claims, agentes nem auditoria", async () => {
    await seedVerification(db);
    await db.query(`insert into kb_factchecks (source_name, url, claim_text, rating_original, verdict, quote)
                    values ('Lupa', 'https://lupa.uol.com.br/a', 'c', 'Falso', 'contradito', 'q')`);
    for (const table of ["kb_factchecks", "claims", "capture_agents", "alert_events", "editors"]) {
      const r = await asRole(db, "anon", null, () => db.query(`select * from ${table}`));
      expect(r.rows, table).toHaveLength(0);
    }
  });

  it("[RNF05] anon não escreve em alerts nem segments", async () => {
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, true);
    await expect(asRole(db, "anon", null, () => insertAlert(db, s, "published"))).rejects.toThrow();
    await expect(asRole(db, "anon", null, () => db.query(
      `insert into segments (debate_id, agent_id, seq, text, t_start, t_end, captured_at)
       values ($1, $2, 99, 'x', 0, 1, now())`, [s.debate, s.agent]))).rejects.toThrow();
  });

  it("[RNF05] RPCs sensíveis revogadas para o público", async () => {
    const s = await seedVerification(db);
    await expect(asRole(db, "anon", null, () => db.query(`select capture_heartbeat($1)`, [s.agent]))).rejects.toThrow();
    await expect(asRole(db, "authenticated", STRANGER, () => db.query(`select capture_heartbeat($1)`, [s.agent]))).rejects.toThrow();
    await expect(asRole(db, "anon", null, () => db.query(`select capture_set_active($1)`, [s.agent]))).rejects.toThrow();
  });

  it("[RNF05] público lê alerta publicado com suas evidências", async () => {
    const s = await seedVerification(db);
    await addEvidence(db, s.verification, true);
    await insertAlert(db, s, "published");
    const r = await asRole(db, "anon", null, () => db.query(
      `select a.id, e.url from alerts a join evidence e on e.verification_id = a.verification_id`));
    expect(r.rows).toHaveLength(1);
  });
});

describe("[RNF08] idempotência", () => {
  it("[RNF08] reenviar (agent_id, seq) não cria segmento novo", async () => {
    const s = await seedVerification(db);
    await expect(db.query(
      `insert into segments (debate_id, agent_id, seq, text, t_start, t_end, captured_at)
       values ($1, $2, 1, 'fala', 0, 1, now())`, [s.debate, s.agent])).rejects.toThrow();
    const c = await one<{ n: number }>(db, `select count(*)::int as n from segments`);
    expect(c.n).toBe(1);
  });
});

describe("[RF09] atribuição", () => {
  it("[RF09] speaker_map é público para leitura e só editor escreve", async () => {
    await makeEditor();
    const s = await seedVerification(db);
    await expect(asRole(db, "anon", null, () =>
      db.query(`insert into speaker_map (debate_id, speaker_label, person) values ($1, 'S0', 'X')`, [s.debate]))).rejects.toThrow();
    await asRole(db, "authenticated", EDITOR, () =>
      db.query(`insert into speaker_map (debate_id, speaker_label, person) values ($1, 'S0', 'X')`, [s.debate]));
    const r = await asRole(db, "anon", null, () => db.query(`select * from speaker_map`));
    expect(r.rows).toHaveLength(1);
  });
});
