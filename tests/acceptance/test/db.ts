// Postgres embutido (PGlite) com as migrations reais e um ambiente que imita o
// Supabase: schema auth, papéis anon/authenticated com os grants padrão e
// auth.uid()/auth.role()/auth.jwt() lidos das claims da sessão. Permite testar RLS de verdade.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(here, "../../../supabase/migrations");

const SUPABASE_STUB = `
create schema auth;
create schema extensions;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'service_role') $$;
-- Igual ao do Supabase: todas as claims do JWT (ex.: aal) ou null fora de sessão.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
-- Como no Supabase: funções novas em public são executáveis por anon/authenticated
-- (revogar de public não basta; as migrations revogam por papel).
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create publication supabase_realtime;
`;

export type Db = PGlite;

export async function freshDb(): Promise<Db> {
  const db = new PGlite({ extensions: { vector, pg_trgm, unaccent } });
  await db.exec(SUPABASE_STUB);
  await db.exec("set search_path = public, extensions;");
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
  }
  return db;
}

/**
 * Executa `fn` como um papel do Supabase (RLS aplicada), voltando ao superusuário no fim.
 * `claims` vira o JWT visto por auth.jwt() (ex.: `{ aal: "aal1" }` para sessão só com senha).
 */
export async function asRole<T>(
  db: Db,
  role: "anon" | "authenticated",
  userId: string | null,
  fn: () => Promise<T>,
  claims: Record<string, string> = {},
): Promise<T> {
  const jwt = JSON.stringify({ ...claims, role, ...(userId ? { sub: userId } : {}) });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [jwt]);
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ""}', false);
                 select set_config('request.jwt.claim.role', '${role}', false);
                 set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;
                   select set_config('request.jwt.claim.sub', '', false);
                   select set_config('request.jwt.claim.role', '', false);
                   select set_config('request.jwt.claims', '', false);`);
  }
}

export function vec(x: number): string {
  return "[" + Array.from({ length: 1024 }, (_, i) => (i === 0 ? x : i === 1 ? 1 - x : 0)).join(",") + "]";
}

let n = 0;
export async function one<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] as T;
}

/** Monta debate + agente ativo + segmento + claim + verificação contradito. */
export async function seedVerification(db: Db, opts: { verdict?: string } = {}) {
  n++;
  const debate = (await one<{ id: string }>(db, `insert into debates (slug, title) values ($1, 'D') returning id`, [`d${n}`])).id;
  const agent = (await one<{ id: string }>(
    db, `insert into capture_agents (debate_id, name, source) values ($1, 'p', 'file') returning id`, [debate])).id;
  await db.query(`select capture_heartbeat($1)`, [agent]);
  const segment = (await one<{ id: number }>(
    db, `insert into segments (debate_id, agent_id, seq, text, t_start, t_end, captured_at)
         values ($1, $2, 1, 'fala', 0, 1, now()) returning id`, [debate, agent])).id;
  const claim = (await one<{ id: string }>(
    db, `insert into claims (debate_id, segment_id, text_original, text_normalized, claim_hash, embedding)
         values ($1, $2, 'a', 'a', $3, $4) returning id`, [debate, segment, `h${n}`, vec(1)])).id;
  const verification = (await one<{ id: string }>(
    db, `insert into verifications (claim_id, verdict, model_confidence, final_score, layer)
         values ($1, $2, 0.9, 0.9, 'L1') returning id`, [claim, opts.verdict ?? "contradito"])).id;
  return { debate, agent, segment, claim, verification };
}

export async function addEvidence(db: Db, verificationId: string, verified: boolean, url = "https://lupa.uol.com.br/x") {
  await db.query(
    `insert into evidence (verification_id, evidence_type, url, source_name, source_tier, quote, quote_verified)
     values ($1, 'factcheck', $2, 'Lupa', 1, 'trecho da fonte', $3)`, [verificationId, url, verified]);
}

export async function insertAlert(db: Db, s: { debate: string; claim: string; verification: string }, status: string) {
  return (await one<{ id: string }>(
    db, `insert into alerts (debate_id, claim_id, verification_id, verdict, status, claim_text, summary, correction)
         values ($1, $2, $3, 'contradito', $4, 'afirmação', 'resumo', 'correção') returning id`,
    [s.debate, s.claim, s.verification, status])).id;
}
