-- Fatos de referência (camada L2): mandatos presidenciais e resultados oficiais
-- de eleição presidencial, curados com fonte. O pipeline faz a conta em código
-- (retrieve/reference.ts) — ex.: "o PT governou 20 dos últimos 24 anos" vira a
-- soma dos mandatos — e gera a evidência com o número calculado.
--
-- Dados curados: cada linha tem fonte oficial (ou de nível 2) e trecho literal;
-- foram conferidos por pesquisa com verificação independente e revisão humana.
-- Corrigir um valor = nova migration (as linhas são reescritas por id).
--
-- Só service role (RLS sem políticas), como as tabelas kb_*. Não destrutiva.

create table if not exists ref_mandatos (
  id text primary key,
  pessoa text not null,
  -- sigla do partido no período (mandato dividido quando o presidente trocou de partido)
  partido text not null,
  inicio date not null,
  -- null = em curso; o fim é exclusivo (o dia da posse do sucessor)
  fim date,
  papel text not null check (papel in ('titular', 'interino')),
  fonte_nome text not null,
  fonte_url text not null check (fonte_url ~* '^https?://'),
  trecho text not null check (length(btrim(trecho)) > 0),
  notas text,
  check (fim is null or fim > inicio)
);

create table if not exists ref_eleicoes (
  id text primary key,
  ano int not null,
  turno int not null check (turno in (1, 2)),
  candidato text not null,
  partido text not null,
  votos bigint not null check (votos >= 0),
  pct_validos numeric not null check (pct_validos between 0 and 100),
  eleito boolean not null default false,
  fonte_nome text not null,
  fonte_url text not null check (fonte_url ~* '^https?://'),
  trecho text not null check (length(btrim(trecho)) > 0),
  unique (ano, turno, candidato)
);

alter table ref_mandatos enable row level security;
alter table ref_eleicoes enable row level security;

revoke all on ref_mandatos from anon, authenticated;
revoke all on ref_eleicoes from anon, authenticated;

-- DADOS (preenchidos a partir da pesquisa verificada)
