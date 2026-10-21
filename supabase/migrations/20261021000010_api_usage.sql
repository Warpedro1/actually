-- Uso das APIs externas (painel "Uso das APIs" do /admin).
--
-- O que as próprias APIs não informam (tokens da Voyage, consultas ao Google,
-- custo estimado da Anthropic por modelo…), o sistema conta: o pipeline e a
-- carga da base somam o uso de cada execução e gravam uma vez por trecho/etapa
-- em `api_usage`, agregado por hora. `api_ratelimits` guarda o último retrato
-- dos cabeçalhos de limite (por minuto) que cada API devolveu.
--
-- Tudo só service role: RLS sem políticas e RPCs revogadas de anon/authenticated.
-- Não destrutiva.

create table if not exists api_usage (
  provider text not null,
  model text not null default '',
  bucket timestamptz not null,
  requests int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  -- unidade própria do provedor (créditos da Tavily, consultas, runs…)
  units numeric not null default 0,
  cost_usd numeric not null default 0,
  primary key (provider, model, bucket)
);

create table if not exists api_ratelimits (
  provider text primary key,
  headers jsonb not null,
  observed_at timestamptz not null default now()
);

alter table api_usage enable row level security;
alter table api_ratelimits enable row level security;

-- Soma na hora corrente. Linhas repetidas (mesmo provedor/modelo) são somadas
-- antes do upsert: um único comando não pode atualizar a mesma linha duas vezes.
create or replace function api_usage_add(p_rows jsonb, p_ratelimits jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into api_usage as u (provider, model, bucket, requests, input_tokens, output_tokens, units, cost_usd)
  select r.provider, coalesce(r.model, ''), date_trunc('hour', now()),
         sum(coalesce(r.requests, 0)), sum(coalesce(r.input_tokens, 0)), sum(coalesce(r.output_tokens, 0)),
         sum(coalesce(r.units, 0)), sum(coalesce(r.cost_usd, 0))
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
       as r(provider text, model text, requests int, input_tokens bigint, output_tokens bigint, units numeric, cost_usd numeric)
  where r.provider is not null
  group by r.provider, coalesce(r.model, '')
  on conflict (provider, model, bucket) do update set
    requests = u.requests + excluded.requests,
    input_tokens = u.input_tokens + excluded.input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens,
    units = u.units + excluded.units,
    cost_usd = u.cost_usd + excluded.cost_usd;

  insert into api_ratelimits (provider, headers, observed_at)
  select key, value, now() from jsonb_each(coalesce(p_ratelimits, '{}'::jsonb))
  where jsonb_typeof(value) = 'object'
  on conflict (provider) do update set headers = excluded.headers, observed_at = excluded.observed_at;
end;
$$;

-- Resumo para o painel: por provedor e modelo, na última hora, hoje (Brasília),
-- últimas 24 h e no mês (Brasília); mais o último retrato de limites.
create or replace function api_usage_summary()
returns jsonb
language sql stable security definer set search_path = public as $$
  with b as (
    select date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' as dia,
           date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo' as mes
  ),
  agg as (
    select u.provider, u.model, w.janela,
           sum(u.requests) as requests, sum(u.input_tokens) as input_tokens, sum(u.output_tokens) as output_tokens,
           sum(u.units) as units, sum(u.cost_usd) as cost_usd
    from api_usage u, b,
         lateral (values
           ('hora', u.bucket >= date_trunc('hour', now())),
           ('hoje', u.bucket >= b.dia),
           ('24h', u.bucket >= now() - interval '24 hours'),
           ('mes', u.bucket >= b.mes)
         ) as w(janela, dentro)
    where w.dentro
    group by u.provider, u.model, w.janela
  )
  select jsonb_build_object(
    'usage', coalesce((select jsonb_agg(to_jsonb(agg) order by provider, model, janela) from agg), '[]'::jsonb),
    'ratelimits', coalesce((select jsonb_object_agg(provider, jsonb_build_object('headers', headers, 'observed_at', observed_at)) from api_ratelimits), '{}'::jsonb)
  );
$$;

-- Tamanho do banco e das maiores tabelas (para comparar com o limite do plano).
create or replace function ops_db_size()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object('table', t.relname, 'bytes', pg_total_relation_size(t.oid)) order by pg_total_relation_size(t.oid) desc)
      from (select c.oid, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
            order by pg_total_relation_size(c.oid) desc limit 8) t
    ), '[]'::jsonb)
  );
$$;

revoke execute on function api_usage_add(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function api_usage_summary() from public, anon, authenticated;
revoke execute on function ops_db_size() from public, anon, authenticated;
