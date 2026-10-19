-- L2: como cada série se agrega num período mais longo que a sua periodicidade.
-- O comparador do pipeline (packages/pipeline/src/retrieve/indicators.ts) lê este
-- campo pelo find_indicator_v2; o kb-ingest grava o valor do catálogo
-- (apps/kb-ingest/src/indicators/catalog.ts). Valores = INDICATOR_AGGREGATIONS em
-- packages/db/src/types.ts:
--   sum          fluxo (Caged, PIB nominal): ano/trimestre = soma do período completo
--   mean_or_last taxa com média reconhecida (desocupação, Selic, câmbio): média ou último ponto
--   last         estoque (dívida % PIB): ponto do fim do período
--   accum_12m    acumulado em 12 meses: ano civil = dezembro
--   none         não agrega (variação mensal/trimestral, séries anuais): só o período exato
--
-- SEM default de propósito: as linhas que já existem ficam null até o próximo
-- `kb-ingest indicators`, e o pipeline trata null como "não declarada" ⇒ a L2 fica
-- em silêncio. Um default 'none' deixaria a série mensal do IPCA (que no banco
-- antigo é a única com o alias "inflação") comparar o último mês com "a inflação
-- está em 4,5%" e acusar "contradito".
alter table indicator_series
  add column if not exists aggregation text
  check (aggregation in ('sum', 'mean_or_last', 'last', 'accum_12m', 'none'));

comment on column indicator_series.aggregation is
  'Agregação em período mais longo que a periodicidade: sum | mean_or_last | last | accum_12m | none. '
  'null = não declarada: o pipeline não compara (L2 em silêncio). Gravada pelo kb-ingest indicators.';

-- RETURNS TABLE não muda com create or replace, e recriar find_indicator exigiria
-- DROP (operação destrutiva). A versão com a agregação ganha nome próprio; o
-- pipeline chama find_indicator_v2 e a antiga fica só por compatibilidade.
create or replace function find_indicator_v2(q text, match_count int default 3)
returns table (code text, name text, unit text, periodicity text, aggregation text, source_name text,
               source_url text, tier smallint, score real)
language sql stable set search_path = public, extensions as $$
  select s.code, s.name, s.unit, s.periodicity, s.aggregation, s.source_name, s.source_url, s.tier,
         greatest(
           similarity(unaccent(lower(s.name)), unaccent(lower(q))),
           coalesce((select max(similarity(unaccent(lower(a)), unaccent(lower(q)))) from unnest(s.aliases) a), 0)
         ) as score
  from indicator_series s
  order by score desc
  limit match_count;
$$;
