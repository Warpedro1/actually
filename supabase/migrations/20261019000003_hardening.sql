-- Hardening apontado pelo advisor de segurança do Supabase.

-- search_path fixo em todas as funções (evita sequestro por objetos homônimos)
alter function alerts_require_evidence() set search_path = public, extensions;
alter function forbid_mutation() set search_path = public, extensions;
alter function match_factchecks(extensions.vector, text, int) set search_path = public, extensions;
alter function match_chunks(extensions.vector, text, int, text) set search_path = public, extensions;
alter function match_verified_claims(uuid, extensions.vector, double precision, int) set search_path = public, extensions;
alter function find_indicator(text, int) set search_path = public, extensions;
alter function capture_machines_touch_desired() set search_path = public, extensions;

-- Heartbeat/failover só pela API (service role). Sem isso, qualquer um com o
-- id de um agente poderia mexer no failover via /rest/v1/rpc.
revoke execute on function capture_heartbeat(uuid) from public, anon, authenticated;
-- Troca manual: só usuários autenticados (a função ainda checa is_editor()).
revoke execute on function capture_set_active(uuid) from public, anon;
-- Função de trigger não é RPC.
revoke execute on function alerts_audit() from public, anon, authenticated;
-- is_editor() continua executável por anon/authenticated de propósito: as
-- políticas de RLS a chamam com o papel de quem consulta. Ela só revela se o
-- próprio usuário é editor.

-- Tabelas da base de conhecimento (kb_*, indicator_*) têm RLS sem políticas de
-- propósito: só o service role (pipeline e kb-ingest) lê e escreve.
