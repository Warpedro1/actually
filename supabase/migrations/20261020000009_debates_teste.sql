-- Debate de teste (ensaios): visível só para editores e isolado da trava de
-- repetição entre debates.
--
-- Sem isto, todo debate criado aparece na página inicial (e não pode ser
-- apagado: alertas são append-only), e um alerta publicado num ensaio seria
-- reaproveitado no debate real como "Repetido — já verificado".
--
-- Uma marca só, reversível nos dois sentidos (/admin):
-- - is_test = true: o público não vê o debate nem nada ligado a ele (RLS);
--   vereditos dele não são reaproveitados por outros debates.
-- - is_test = false: volta a ser público e a compartilhar vereditos.
-- Não destrutiva: sem DROP; políticas ajustadas com ALTER POLICY.

alter table debates add column if not exists is_test boolean not null default false;

comment on column debates.is_test is
  'true → só editores veem (RLS) e a trava de repetição de outros debates ignora os vereditos dele.';

-- O debate é público? Função própria (security definer) para as políticas não
-- dependerem da RLS de debates numa subconsulta. Só revela se o id é público.
create or replace function public_debate(p_debate_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select not d.is_test from debates d where d.id = p_debate_id), false);
$$;

alter policy debates_read on debates using (not is_test or is_editor());
alter policy segments_read on segments using (public_debate(debate_id) or is_editor());
alter policy speaker_map_read on speaker_map using (public_debate(debate_id) or is_editor());
alter policy alert_retractions_read on alert_retractions using (public_debate(debate_id) or is_editor());
alter policy alerts_read_published on alerts using ((status = 'published' and public_debate(debate_id)) or is_editor());
alter policy verifications_read on verifications using (
  is_editor() or exists (
    select 1 from alerts a
    where a.verification_id = verifications.id and a.status = 'published' and public_debate(a.debate_id)
  )
);
alter policy evidence_read on evidence using (
  is_editor() or exists (
    select 1 from alerts a
    where a.verification_id = evidence.verification_id and a.status = 'published' and public_debate(a.debate_id)
  )
);

-- Trava de repetição: mesmo debate sempre; de outros debates só se o outro NÃO
-- for teste (alerta publicado ou veredito "confirmado", como antes).
-- Debate real nunca herda veredito de ensaio; um teste não herda de outro teste.
-- create or replace zera a config da função: search_path repetido aqui (0003).
create or replace function match_verified_claims(
  p_debate_id uuid,
  query_embedding extensions.vector(1024),
  min_similarity double precision,
  match_count int default 5
) returns table (
  claim_id uuid, debate_id uuid, text_normalized text, numbers jsonb, indicator jsonb,
  verification_id uuid, verdict verdict, alert_id uuid, alert_status alert_status,
  verified_at timestamptz, similarity double precision
)
language sql stable set search_path = public, extensions as $$
  select c.id, c.debate_id, c.text_normalized, c.numbers, c.indicator,
         v.id, v.verdict, a.id, a.status, v.created_at,
         1 - (c.embedding <=> query_embedding) as similarity
  from claims c
  join debates d on d.id = c.debate_id
  join lateral (
    select * from verifications v where v.claim_id = c.id order by v.created_at desc limit 1
  ) v on true
  left join alerts a on a.verification_id = v.id and not a.is_repeat
  where c.duplicate_of is null
    and c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
    and (
      c.debate_id = p_debate_id
      or (not d.is_test and (a.status = 'published' or v.verdict = 'confirmado'))
    )
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
