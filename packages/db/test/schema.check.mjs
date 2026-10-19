// Valida invariantes do schema num Postgres embutido (PGlite): node test/schema.check.mjs
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import fs from "node:fs";
const db = new PGlite({ extensions: { vector, pg_trgm, unaccent } });
// stubs Supabase
await db.exec(`
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true),''),'service_role') $$;
create publication supabase_realtime;
`);
await db.exec(fs.readFileSync(new URL("../../../supabase/migrations/20261019000001_init.sql", import.meta.url), "utf8"));
const ok = (m) => console.log("OK  ", m);
const fail = (m) => { console.log("FAIL", m); process.exitCode = 1; };
const vec = (x) => "[" + Array.from({length:1024},(_,i)=> i===0?x:(i===1?1-x:0)).join(",") + "]";

const d = (await db.query(`insert into debates (slug,title) values ('t','T') returning id`)).rows[0].id;
const a1 = (await db.query(`insert into capture_agents (debate_id,name,source,role) values ($1,'p','youtube','primary') returning id`,[d])).rows[0].id;
const a2 = (await db.query(`insert into capture_agents (debate_id,name,source,role) values ($1,'s','device','standby') returning id`,[d])).rows[0].id;
// heartbeat / failover
let r = (await db.query(`select capture_heartbeat($1) as a`,[a2])).rows[0].a;
r === true ? ok("standby sozinho vira ativo") : fail("standby sozinho");
r = (await db.query(`select capture_heartbeat($1) as a`,[a1])).rows[0].a;
r === false ? ok("primary não rouba ativo vivo") : fail("primary roubou");
await db.query(`update capture_agents set last_heartbeat = now() - interval '30 seconds' where id=$1`,[a2]);
r = (await db.query(`select capture_heartbeat($1) as a`,[a1])).rows[0].a;
r === true ? ok("failover para primary após standby morrer") : fail("failover");

const s = (await db.query(`insert into segments (debate_id,agent_id,seq,text,t_start,t_end,captured_at) values ($1,$2,1,'x',0,1,now()) returning id`,[d,a1])).rows[0].id;
try { await db.query(`insert into segments (debate_id,agent_id,seq,text,t_start,t_end,captured_at) values ($1,$2,1,'x',0,1,now())`,[d,a1]); fail("seq duplicado aceito"); } catch { ok("seq duplicado rejeitado"); }
try { await db.query(`update segments set text='y' where id=$1`,[s]); fail("segments mutável"); } catch { ok("segments append-only"); }

const c = (await db.query(`insert into claims (debate_id,segment_id,text_original,text_normalized,claim_hash,embedding) values ($1,$2,'a','a','h1',$3) returning id`,[d,s,vec(1)])).rows[0].id;
try { await db.query(`insert into claims (debate_id,segment_id,text_original,text_normalized,claim_hash) values ($1,$2,'a','a','h1')`,[d,s]); fail("hash duplicado"); } catch { ok("trava: hash duplicado rejeitado"); }
await db.query(`insert into claims (debate_id,segment_id,text_original,text_normalized,claim_hash,duplicate_of) values ($1,$2,'a','a','h1',$3)`,[d,s,c]); ok("duplicata com duplicate_of aceita");

const v = (await db.query(`insert into verifications (claim_id,verdict,model_confidence,final_score,layer) values ($1,'contradito',0.9,0.9,'L1') returning id`,[c])).rows[0].id;
try { await db.query(`insert into alerts (debate_id,claim_id,verification_id,verdict,status,claim_text,summary,correction) values ($1,$2,$3,'contradito','published','a','s','c')`,[d,c,v]); fail("publicou sem evidência"); } catch (e) { ok("trigger: sem evidência → " + e.message.slice(0,60)); }
try { await db.query(`insert into evidence (verification_id,evidence_type,url,source_name,source_tier,quote) values ($1,'web','ftp://x','x',1,'q')`,[v]); fail("url inválida"); } catch { ok("url não-http rejeitada"); }
await db.query(`insert into evidence (verification_id,evidence_type,url,source_name,source_tier,quote,quote_verified) values ($1,'web','https://x.org','x',1,'q',false)`,[v]);
try { await db.query(`insert into alerts (debate_id,claim_id,verification_id,verdict,status,claim_text,summary,correction) values ($1,$2,$3,'contradito','published','a','s','c')`,[d,c,v]); fail("publicou com citação não verificada"); } catch { ok("trigger: citação não verificada bloqueia"); }
const al = (await db.query(`insert into alerts (debate_id,claim_id,verification_id,verdict,status,claim_text,summary,correction) values ($1,$2,$3,'contradito','pending_review','a','s','c') returning id`,[d,c,v])).rows[0].id;
ok("pending sem evidência verificada aceito");
try { await db.query(`update alerts set status='published' where id=$1`,[al]); fail("aprovação burlou trigger"); } catch { ok("trigger: aprovação também exige evidência"); }
await db.query(`insert into evidence (verification_id,evidence_type,url,source_name,source_tier,quote,quote_verified) values ($1,'factcheck','https://lupa.uol.com.br/x','Lupa',1,'trecho',true)`,[v]);
await db.query(`update alerts set status='published' where id=$1`,[al]);
const pa = (await db.query(`select published_at from alerts where id=$1`,[al])).rows[0].published_at;
pa ? ok("publicado com evidência; published_at preenchido") : fail("published_at");
const ev = (await db.query(`select count(*)::int n from alert_events where alert_id=$1`,[al])).rows[0].n;
ev === 2 ? ok("auditoria registrou 2 eventos") : fail("auditoria " + ev);
try { await db.query(`insert into alerts (debate_id,claim_id,verification_id,verdict,status,claim_text,summary,correction) values ($1,$2,$3,'confirmado','pending_review','a','s','c')`,[d,c,v]); fail("alerta confirmado"); } catch { ok("alerta só para contradito/impreciso"); }

// RPCs
const m = (await db.query(`select * from match_verified_claims($1,$2,0.9)`,[d,vec(1)])).rows;
m.length === 1 && m[0].alert_status === 'published' ? ok("match_verified_claims") : fail("match_verified_claims " + JSON.stringify(m));
await db.query(`insert into kb_factchecks (source_name,url,claim_text,rating_original,verdict,quote,embedding) values ('Lupa','https://lupa.uol.com.br/a','O desemprego caiu para 6 por cento','Falso','contradito','Dados do IBGE mostram',$1)`,[vec(1)]);
const f = (await db.query(`select * from match_factchecks($1,'desemprego caiu',5)`,[vec(0.9)])).rows;
f.length === 1 && f[0].similarity > 0.9 ? ok("match_factchecks híbrido") : fail("match_factchecks " + JSON.stringify(f));
const doc = (await db.query(`insert into kb_documents (url,title,doc_type,source_name,tier,body) values ('https://senado.leg.br/x','t','votacao','Senado',1,'b') returning id`)).rows[0].id;
await db.query(`insert into kb_chunks (document_id,chunk_index,text,embedding) values ($1,0,'Votação da reforma tributária no Senado',$2)`,[doc,vec(1)]);
const ch = (await db.query(`select * from match_chunks($1,'reforma tributária',5)`,[vec(1)])).rows;
ch.length === 1 ? ok("match_chunks híbrido") : fail("match_chunks");
await db.query(`insert into indicator_series (code,name,aliases,unit,periodicity,source_name,source_url) values ('desocupacao_pnadc','Taxa de desocupação','{desemprego,"taxa de desemprego"}','%','moving_quarter','IBGE','https://sidra.ibge.gov.br')`);
const ind = (await db.query(`select * from find_indicator('desemprego')`)).rows;
ind[0]?.code === 'desocupacao_pnadc' && ind[0].score > 0.5 ? ok("find_indicator por alias") : fail("find_indicator " + JSON.stringify(ind));
