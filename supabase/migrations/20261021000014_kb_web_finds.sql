-- A base aprende com a web: as páginas que a busca web (L4, só domínios de nível 1–2)
-- trouxe durante a checagem entram numa fila e viram checagem (L1, quando é página de
-- agência com selo) ou documento (L3) em segundo plano, pela carga (etapa "web-finds").
-- O pipeline só grava a fila — uma inserção por trecho, depois da decisão do alerta; o
-- trabalho pesado (texto limpo, chunks e embeddings) fica com a carga.
--
-- `origin` marca o que entrou na base por esse caminho ('web'): auditoria e, se preciso,
-- remoção em bloco. Tudo só service role (RLS sem políticas). Não destrutiva.

alter table kb_documents add column if not exists origin text;
alter table kb_factchecks add column if not exists origin text;

create table if not exists kb_web_finds (
  id uuid primary key default gen_random_uuid(),
  url text not null unique check (url ~* '^https?://'),
  title text not null default '',
  text text not null,
  source_name text not null,
  tier smallint not null check (tier between 1 and 2),
  published_at timestamptz,
  -- a busca que trouxe a página (afirmação normalizada ou o que a mede)
  query text,
  debate_id uuid references debates (id) on delete set null,
  found_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'skipped', 'failed')),
  claimed_at timestamptz,
  processed_at timestamptz,
  note text
);

create index if not exists kb_web_finds_queue on kb_web_finds (found_at) where status in ('pending', 'processing');

alter table kb_web_finds enable row level security;
revoke all on kb_web_finds from anon, authenticated;

-- Pega até p_limit páginas da fila (no máximo 50) e as marca como "processing". Página
-- presa em "processing" há mais de 10 min (a função que a pegou morreu) volta a valer.
-- skip locked: duas execuções da carga nunca pegam a mesma página.
create or replace function kb_web_finds_claim(p_limit int)
returns setof kb_web_finds
language sql security definer set search_path = public as $$
  with claimed as (
    update kb_web_finds f set status = 'processing', claimed_at = now()
    where f.id in (
      select q.id from kb_web_finds q
      where q.status = 'pending' or (q.status = 'processing' and q.claimed_at < now() - interval '10 minutes')
      order by q.found_at
      limit greatest(1, least(coalesce(p_limit, 10), 50))
      for update skip locked
    )
    returning f.*
  )
  select * from claimed order by found_at;
$$;

revoke execute on function kb_web_finds_claim(int) from public, anon, authenticated;
grant execute on function kb_web_finds_claim(int) to service_role;
