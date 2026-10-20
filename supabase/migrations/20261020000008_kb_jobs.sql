-- Carga da base pelo /admin: cada pedido do editor vira uma tarefa (kb_jobs)
-- com uma fila de etapas curtas. As funções da Vercel executam as etapas em
-- pedaços (cada invocação tem tempo limitado) e passam o bastão para a próxima.
--
-- - Uma tarefa por vez: kb_job_claim pega a mais antiga pendente sob trava
--   consultiva, então duas invocações simultâneas nunca rodam juntas.
-- - Quem roda segura um "lease" (lease_until). Se a função morrer no meio, o
--   lease vence e a próxima chamada (painel do /admin aberto, cron diário ou
--   novo pedido) retoma da etapa que estava em andamento. As etapas são
--   idempotentes (upserts), então repetir uma não duplica nada.
-- - Escrita só pelo service role (rotas /api/kb/*). Editores só leem.

create table kb_jobs (
  id uuid primary key default gen_random_uuid(),
  -- preset pedido no painel (ver KbJobPreset em packages/db/src/types.ts)
  preset text not null,
  title text not null,
  params jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'canceled')),
  -- fila de etapas pendentes (KbStep[]); a primeira é a próxima a rodar
  steps jsonb not null default '[]'::jsonb,
  -- para o painel mostrar o tamanho da fila sem baixar as etapas
  steps_pending int generated always as (jsonb_array_length(steps)) stored,
  -- etapa em execução (null entre etapas); se o lease vencer, volta para a fila
  current jsonb,
  -- tentativas da etapa em `current` (o runner desiste dela na 3ª queda)
  current_attempts int not null default 0,
  steps_done int not null default 0,
  steps_failed int not null default 0,
  -- últimas linhas de log: [{t, level: "info"|"warn"|"error", msg}]
  log jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz
);

create index kb_jobs_pending on kb_jobs (created_at) where status in ('queued', 'running');

alter table kb_jobs enable row level security;
create policy kb_jobs_editor_read on kb_jobs for select using (is_editor());

-- Pega a próxima tarefa pendente para `p_owner` por `p_lease_s` segundos.
-- Devolve nada se outra invocação está com o lease válido de alguma tarefa
-- (uma por vez) ou se não há pendências.
create or replace function kb_job_claim(p_owner text, p_lease_s int)
returns setof kb_jobs
language plpgsql security definer set search_path = public as $$
begin
  if not pg_try_advisory_xact_lock(hashtext('kb_jobs_runner')) then
    return;
  end if;
  if exists (
    select 1 from kb_jobs
    where status in ('queued', 'running') and lease_until is not null and lease_until >= now()
  ) then
    return;
  end if;
  return query
  update kb_jobs j
     set lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_lease_s),
         status = 'running',
         started_at = coalesce(j.started_at, now()),
         updated_at = now()
   where j.id = (
     select id from kb_jobs
     where status in ('queued', 'running')
     order by created_at
     limit 1
     for update skip locked
   )
  returning j.*;
end;
$$;

revoke execute on function kb_job_claim(text, int) from public, anon, authenticated;

-- Resumo da base para o painel e para a etapa "status" (uma ida ao banco em vez
-- de dez contagens). Só o service role executa: kb_*/indicator_* são privadas.
create or replace function kb_counts() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'source_tiers', (select count(*) from source_tiers),
    'kb_factchecks', (select count(*) from kb_factchecks),
    'kb_factchecks_sem_embedding', (select count(*) from kb_factchecks where embedding is null),
    'ultima_checagem', (select max(published_at) from kb_factchecks),
    'checagens_por_veredito', (
      select coalesce(jsonb_object_agg(verdict, n), '{}'::jsonb)
      from (select verdict::text, count(*) n from kb_factchecks group by verdict) x),
    'indicator_series', (select count(*) from indicator_series),
    'indicator_values', (select count(*) from indicator_values),
    'series', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', s.code, 'name', s.name, 'aggregation', s.aggregation, 'values', v.n, 'last', v.last)
             order by s.code), '[]'::jsonb)
      from indicator_series s
      left join lateral (
        select count(*) n, max(period_end) last from indicator_values where series_code = s.code
      ) v on true),
    'kb_documents', (select count(*) from kb_documents),
    'documentos_por_tipo', (
      select coalesce(jsonb_object_agg(doc_type, n), '{}'::jsonb)
      from (select doc_type::text, count(*) n from kb_documents group by doc_type) x),
    'kb_chunks', (select count(*) from kb_chunks),
    'kb_chunks_sem_embedding', (select count(*) from kb_chunks where embedding is null)
  );
$$;

revoke execute on function kb_counts() from public, anon, authenticated;
