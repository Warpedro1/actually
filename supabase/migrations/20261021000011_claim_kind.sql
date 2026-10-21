-- Tipo da fala em `claims` (ensaio de 21/10): além de fato e estatística, o
-- extrator passa a julgar opinião com base mensurável, previsão e acusação
-- (cada uma com regras próprias no pipeline). Promessa e opinião pura são
-- descartadas antes de virar linha aqui.
--
-- `measurable`: o dado ou a projeção pública que mede uma opinião/previsão.
-- Não destrutiva: colunas novas com padrão; linhas antigas viram "fato".

alter table claims add column if not exists kind text not null default 'fato'
  check (kind in ('fato', 'estatistica', 'acusacao', 'opiniao_mensuravel', 'previsao'));
alter table claims add column if not exists measurable text;

comment on column claims.kind is
  'Tipo da fala: fato | estatistica | acusacao | opiniao_mensuravel | previsao (regras por tipo no pipeline).';
comment on column claims.measurable is
  'Opinião/previsão: o dado ou a projeção pública que mede a fala (consulta das camadas L3/L4).';
