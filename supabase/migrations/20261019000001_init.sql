-- actually — schema inicial
-- Princípios: (1) correção sem fonte não existe — garantido por trigger;
-- (2) trilha de auditoria append-only; (3) anon só enxerga o que foi publicado.

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type verdict as enum ('contradito', 'impreciso', 'confirmado', 'inconclusivo');
create type alert_status as enum ('pending_review', 'published', 'rejected');
create type evidence_type as enum ('factcheck', 'indicator', 'document', 'web');
create type kb_layer as enum ('L1', 'L2', 'L3', 'L4');
create type capture_source as enum ('youtube', 'device', 'file');
create type capture_role as enum ('primary', 'standby');

-- ---------------------------------------------------------------------------
-- Editores (Supabase Auth) — quem pode aprovar alertas e mudar settings
-- ---------------------------------------------------------------------------
create table editors (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create or replace function is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from editors where user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Operacional
-- ---------------------------------------------------------------------------
create table debates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  youtube_url text,
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'ended')),
  settings jsonb not null default '{
    "require_red_approval": true,
    "require_yellow_approval": false,
    "t_red": 0.85,
    "t_yellow": 0.75,
    "web_penalty": 0.05,
    "show_attribution": false,
    "dedup_similarity": 0.92,
    "context_window_s": 60,
    "failover_after_s": 10
  }'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);

create table capture_agents (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates (id) on delete cascade,
  name text not null,
  source capture_source not null,
  role capture_role not null default 'primary',
  active boolean not null default false,
  last_heartbeat timestamptz,
  created_at timestamptz not null default now()
);
-- no máximo um agente ativo por debate
create unique index capture_agents_one_active on capture_agents (debate_id) where active;

create table segments (
  id bigint generated always as identity primary key,
  debate_id uuid not null references debates (id) on delete cascade,
  agent_id uuid not null references capture_agents (id),
  seq integer not null,                -- sequência local do agente (idempotência de retry)
  speaker_label text,
  text text not null,
  t_start numeric not null,            -- segundos desde o início da captura
  t_end numeric not null,
  captured_at timestamptz not null,    -- quando a fala terminou, no relógio do agente
  received_at timestamptz not null default now(),
  unique (agent_id, seq)
);
create index segments_debate_time on segments (debate_id, received_at desc);

create table claims (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates (id) on delete cascade,
  segment_id bigint not null references segments (id),
  speaker_label text,
  text_original text not null,
  text_normalized text not null,
  claim_hash text not null,
  numbers jsonb not null default '[]'::jsonb,
  topic text,
  indicator jsonb,
  embedding vector(1024),
  duplicate_of uuid references claims (id),
  created_at timestamptz not null default now()
);
-- trava de repetição contra corrida entre invocações paralelas
create unique index claims_unique_hash on claims (debate_id, claim_hash) where duplicate_of is null;
create index claims_embedding on claims using hnsw (embedding vector_cosine_ops);

create table verifications (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims (id),
  verdict verdict not null,
  correction text,                     -- 1 linha com o dado correto
  model_confidence numeric not null check (model_confidence between 0 and 1),
  final_score numeric not null check (final_score between 0 and 1),
  score_components jsonb not null default '{}'::jsonb,
  layer kb_layer not null,
  model text,
  latency_ms jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index verifications_claim on verifications (claim_id);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  verification_id uuid not null references verifications (id),
  evidence_type evidence_type not null,
  url text not null check (url ~* '^https?://'),
  source_name text not null,
  source_tier smallint not null check (source_tier between 1 and 4),
  quote text not null check (length(btrim(quote)) > 0),
  quote_verified boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create index evidence_verification on evidence (verification_id);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  debate_id uuid not null references debates (id) on delete cascade,
  claim_id uuid not null references claims (id),
  verification_id uuid not null references verifications (id),
  -- alertas só existem para correções; "confirmado"/"inconclusivo" ficam só no log
  verdict verdict not null check (verdict in ('contradito', 'impreciso')),
  status alert_status not null,
  claim_text text not null,
  summary text not null,
  correction text not null,
  speaker_label text,
  is_repeat boolean not null default false,
  repeat_of uuid references alerts (id),
  segment_t_end numeric,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  reject_reason text
);
create index alerts_debate_status on alerts (debate_id, status, created_at desc);

create table alert_events (
  id bigint generated always as identity primary key,
  alert_id uuid not null references alerts (id),
  action text not null,
  actor uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);

create table speaker_map (
  debate_id uuid not null references debates (id) on delete cascade,
  speaker_label text not null,
  person text not null,
  confirmed_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  primary key (debate_id, speaker_label)
);

-- ---------------------------------------------------------------------------
-- Base de conhecimento
-- ---------------------------------------------------------------------------
create table source_tiers (
  domain text primary key,             -- ex.: ibge.gov.br (casa subdomínios)
  name text not null,
  tier smallint not null check (tier between 1 and 4),
  kind text not null                   -- oficial | checagem | imprensa | academico | campanha | outro
);

-- L1: checagens já publicadas
create table kb_factchecks (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  url text not null unique check (url ~* '^https?://'),
  claim_text text not null,
  rating_original text not null,
  verdict verdict not null,
  person text,
  topic text,
  quote text not null,                 -- trecho da checagem que sustenta o veredito
  body text,
  published_at timestamptz,
  embedding vector(1024),
  tsv tsvector generated always as (
    to_tsvector('portuguese', coalesce(claim_text, '') || ' ' || coalesce(quote, ''))
  ) stored,
  created_at timestamptz not null default now()
);
create index kb_factchecks_embedding on kb_factchecks using hnsw (embedding vector_cosine_ops);
create index kb_factchecks_tsv on kb_factchecks using gin (tsv);

-- L2: indicadores oficiais (consulta estruturada, sem embeddings)
create table indicator_series (
  code text primary key,               -- ex.: desocupacao_pnadc
  name text not null,
  aliases text[] not null default '{}',
  unit text not null,                  -- '%', 'R$', 'km2', 'pessoas'...
  periodicity text not null check (periodicity in ('monthly', 'quarterly', 'annual', 'moving_quarter')),
  source_name text not null,
  source_url text not null check (source_url ~* '^https?://'),
  tier smallint not null default 1 check (tier between 1 and 4),
  notes text
);
create index indicator_series_aliases on indicator_series using gin (aliases);

create table indicator_values (
  series_code text not null references indicator_series (code) on delete cascade,
  period_start date not null,
  period_end date not null,
  value numeric not null,
  released_at date,
  primary key (series_code, period_start)
);

-- L3: documentos de contexto
create table kb_documents (
  id uuid primary key default gen_random_uuid(),
  url text not null unique check (url ~* '^https?://'),
  title text not null,
  doc_type text not null check (doc_type in ('programa', 'entrevista', 'discurso', 'debate', 'lei', 'votacao', 'noticia', 'dado', 'outro')),
  person text,
  source_name text not null,
  tier smallint not null check (tier between 1 and 4),
  published_at timestamptz,
  topics text[] not null default '{}',
  body text not null,
  created_at timestamptz not null default now()
);

create table kb_chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references kb_documents (id) on delete cascade,
  chunk_index integer not null,
  text text not null,
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('portuguese', text)) stored,
  unique (document_id, chunk_index)
);
create index kb_chunks_embedding on kb_chunks using hnsw (embedding vector_cosine_ops);
create index kb_chunks_tsv on kb_chunks using gin (tsv);

-- ---------------------------------------------------------------------------
-- Garantia central: correção publicada sempre tem fonte verificada
-- ---------------------------------------------------------------------------
create or replace function alerts_require_evidence() returns trigger
language plpgsql as $$
begin
  if new.status = 'published' then
    if not exists (
      select 1 from evidence e
      where e.verification_id = new.verification_id
        and e.quote_verified
        and e.url ~* '^https?://'
        and length(btrim(e.quote)) > 0
    ) then
      raise exception 'alerta % não pode ser publicado sem evidência com URL e trecho verificado', new.id
        using errcode = 'check_violation';
    end if;
    if new.published_at is null then
      new.published_at := now();
    end if;
  end if;
  return new;
end;
$$;

create trigger alerts_require_evidence
  before insert or update on alerts
  for each row execute function alerts_require_evidence();

-- Auditoria de alertas
create or replace function alerts_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into alert_events (alert_id, action, actor, after)
    values (new.id, 'created:' || new.status, auth.uid(), to_jsonb(new));
  else
    insert into alert_events (alert_id, action, actor, before, after)
    values (new.id, 'updated:' || old.status || '->' || new.status, auth.uid(), to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$$;

create trigger alerts_audit
  after insert or update on alerts
  for each row execute function alerts_audit();

-- Append-only: trilha de auditoria não pode ser reescrita
create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'tabela % é append-only', tg_table_name;
end;
$$;

create trigger segments_append_only before update or delete on segments
  for each row execute function forbid_mutation();
create trigger verifications_append_only before update or delete on verifications
  for each row execute function forbid_mutation();
create trigger evidence_append_only before update or delete on evidence
  for each row execute function forbid_mutation();
create trigger alert_events_append_only before update or delete on alert_events
  for each row execute function forbid_mutation();
create trigger alerts_no_delete before delete on alerts
  for each row execute function forbid_mutation();

-- ---------------------------------------------------------------------------
-- Captura: heartbeat + failover atômico
-- ---------------------------------------------------------------------------
-- Chamado pelo capture agent a cada ~2 s. Retorna se este agente está ativo.
-- Se nenhum agente ativo deu sinal dentro de failover_after_s, promove o
-- agente vivo mais adequado (primary antes de standby).
create or replace function capture_heartbeat(p_agent_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_debate uuid;
  v_window interval;
  v_active_alive boolean;
  v_candidate uuid;
begin
  update capture_agents set last_heartbeat = now()
  where id = p_agent_id
  returning debate_id into v_debate;
  if v_debate is null then
    raise exception 'agente % não existe', p_agent_id;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_debate::text));

  select make_interval(secs => coalesce((settings ->> 'failover_after_s')::numeric, 10))
  into v_window from debates where id = v_debate;

  select exists (
    select 1 from capture_agents
    where debate_id = v_debate and active and last_heartbeat > now() - v_window
  ) into v_active_alive;

  if not v_active_alive then
    select id into v_candidate from capture_agents
    where debate_id = v_debate and last_heartbeat > now() - v_window
    order by (role = 'primary') desc, last_heartbeat desc
    limit 1;

    update capture_agents set active = false where debate_id = v_debate and active;
    update capture_agents set active = true where id = v_candidate;
  end if;

  return (select active from capture_agents where id = p_agent_id);
end;
$$;

-- Troca manual (admin/editor)
create or replace function capture_set_active(p_agent_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_debate uuid;
begin
  if not is_editor() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'sem permissão';
  end if;
  select debate_id into v_debate from capture_agents where id = p_agent_id;
  perform pg_advisory_xact_lock(hashtext(v_debate::text));
  update capture_agents set active = false where debate_id = v_debate and active;
  update capture_agents set active = true where id = p_agent_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Busca (RPC) — usadas pelo pipeline
-- ---------------------------------------------------------------------------
-- Híbrida: similaridade vetorial + full-text, combinadas por Reciprocal Rank Fusion.
create or replace function match_factchecks(
  query_embedding vector(1024),
  query_text text,
  match_count int default 8
) returns table (
  id uuid, source_name text, url text, claim_text text, rating_original text,
  verdict verdict, person text, quote text, body text, published_at timestamptz,
  similarity double precision, rrf_score double precision
)
language sql stable as $$
  with sem as (
    select f.id, 1 - (f.embedding <=> query_embedding) as similarity,
           row_number() over (order by f.embedding <=> query_embedding) as r
    from kb_factchecks f
    where f.embedding is not null
    order by f.embedding <=> query_embedding
    limit match_count * 4
  ),
  kw as (
    select f.id, row_number() over (order by ts_rank_cd(f.tsv, q) desc) as r
    from kb_factchecks f, websearch_to_tsquery('portuguese', query_text) q
    where f.tsv @@ q
    limit match_count * 4
  ),
  fused as (
    select coalesce(sem.id, kw.id) as id,
           coalesce(1.0 / (60 + sem.r), 0) + coalesce(1.0 / (60 + kw.r), 0) as rrf_score
    from sem full outer join kw on sem.id = kw.id
  )
  select f.id, f.source_name, f.url, f.claim_text, f.rating_original, f.verdict, f.person,
         f.quote, f.body, f.published_at,
         coalesce(1 - (f.embedding <=> query_embedding), 0) as similarity,
         fused.rrf_score
  from fused join kb_factchecks f on f.id = fused.id
  order by fused.rrf_score desc
  limit match_count;
$$;

create or replace function match_chunks(
  query_embedding vector(1024),
  query_text text,
  match_count int default 8,
  filter_person text default null
) returns table (
  chunk_id bigint, document_id uuid, url text, title text, doc_type text, person text,
  source_name text, tier smallint, published_at timestamptz, text text,
  similarity double precision, rrf_score double precision
)
language sql stable as $$
  with sem as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as r
    from kb_chunks c join kb_documents d on d.id = c.document_id
    where c.embedding is not null and (filter_person is null or d.person = filter_person)
    order by c.embedding <=> query_embedding
    limit match_count * 4
  ),
  kw as (
    select c.id, row_number() over (order by ts_rank_cd(c.tsv, q) desc) as r
    from kb_chunks c join kb_documents d on d.id = c.document_id,
         websearch_to_tsquery('portuguese', query_text) q
    where c.tsv @@ q and (filter_person is null or d.person = filter_person)
    limit match_count * 4
  ),
  fused as (
    select coalesce(sem.id, kw.id) as id,
           coalesce(1.0 / (60 + sem.r), 0) + coalesce(1.0 / (60 + kw.r), 0) as rrf_score
    from sem full outer join kw on sem.id = kw.id
  )
  select c.id, d.id, d.url, d.title, d.doc_type, d.person, d.source_name, d.tier, d.published_at,
         c.text, coalesce(1 - (c.embedding <=> query_embedding), 0), fused.rrf_score
  from fused join kb_chunks c on c.id = fused.id join kb_documents d on d.id = c.document_id
  order by fused.rrf_score desc
  limit match_count;
$$;

-- Trava de repetição: afirmações já verificadas (mesmo debate, ou de outros
-- debates quando houve alerta publicado ou veredito "confirmado").
create or replace function match_verified_claims(
  p_debate_id uuid,
  query_embedding vector(1024),
  min_similarity double precision,
  match_count int default 5
) returns table (
  claim_id uuid, debate_id uuid, text_normalized text, numbers jsonb, indicator jsonb,
  verification_id uuid, verdict verdict, alert_id uuid, alert_status alert_status,
  verified_at timestamptz, similarity double precision
)
language sql stable as $$
  select c.id, c.debate_id, c.text_normalized, c.numbers, c.indicator,
         v.id, v.verdict, a.id, a.status, v.created_at,
         1 - (c.embedding <=> query_embedding) as similarity
  from claims c
  join lateral (
    select * from verifications v where v.claim_id = c.id order by v.created_at desc limit 1
  ) v on true
  left join alerts a on a.verification_id = v.id and not a.is_repeat
  where c.duplicate_of is null
    and c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
    and (c.debate_id = p_debate_id or a.status = 'published' or v.verdict = 'confirmado')
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- L2: encontra a série pelo nome/alias (sem acento, tolerante a erro)
create or replace function find_indicator(q text, match_count int default 3)
returns table (code text, name text, unit text, periodicity text, source_name text,
               source_url text, tier smallint, score real)
language sql stable as $$
  select s.code, s.name, s.unit, s.periodicity, s.source_name, s.source_url, s.tier,
         greatest(
           similarity(unaccent(lower(s.name)), unaccent(lower(q))),
           coalesce((select max(similarity(unaccent(lower(a)), unaccent(lower(q)))) from unnest(s.aliases) a), 0)
         ) as score
  from indicator_series s
  order by score desc
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table editors enable row level security;
alter table debates enable row level security;
alter table capture_agents enable row level security;
alter table segments enable row level security;
alter table claims enable row level security;
alter table verifications enable row level security;
alter table evidence enable row level security;
alter table alerts enable row level security;
alter table alert_events enable row level security;
alter table speaker_map enable row level security;
alter table source_tiers enable row level security;
alter table kb_factchecks enable row level security;
alter table indicator_series enable row level security;
alter table indicator_values enable row level security;
alter table kb_documents enable row level security;
alter table kb_chunks enable row level security;

-- Público: debates, transcrição, alertas publicados e suas evidências
create policy debates_read on debates for select using (true);
create policy segments_read on segments for select using (true);
create policy alerts_read_published on alerts for select using (status = 'published' or is_editor());
create policy verifications_read on verifications for select using (
  is_editor() or exists (select 1 from alerts a where a.verification_id = verifications.id and a.status = 'published')
);
create policy evidence_read on evidence for select using (
  is_editor() or exists (select 1 from alerts a where a.verification_id = evidence.verification_id and a.status = 'published')
);
create policy speaker_map_read on speaker_map for select using (true);
create policy source_tiers_read on source_tiers for select using (true);

-- Editores
create policy editors_self on editors for select using (user_id = auth.uid());
create policy claims_editor on claims for select using (is_editor());
create policy capture_agents_editor on capture_agents for select using (is_editor());
create policy alert_events_editor on alert_events for select using (is_editor());
create policy alerts_editor_update on alerts for update using (is_editor()) with check (is_editor());
create policy debates_editor_update on debates for update using (is_editor()) with check (is_editor());
create policy debates_editor_insert on debates for insert with check (is_editor());
create policy speaker_map_editor_write on speaker_map for all using (is_editor()) with check (is_editor());
-- KB e escrita do pipeline: somente service role (bypassa RLS)

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table alerts;
alter publication supabase_realtime add table segments;
