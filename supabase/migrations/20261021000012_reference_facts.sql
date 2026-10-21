-- Fatos de referência (camada L2): mandatos presidenciais e resultados oficiais
-- de eleição presidencial, curados com fonte. O pipeline faz a conta em código
-- (retrieve/reference.ts) — ex.: "o PT governou 20 dos últimos 24 anos" vira a
-- soma dos mandatos — e gera a evidência com o número calculado.
--
-- Dados curados: cada linha tem a fonte oficial onde o dado é publicado, o dado
-- como registrado (`trecho`) e `conferencia`, que diz como a linha foi conferida.
-- Em 21/10/2026 o ambiente de pesquisa não abria as fontes (proxy) e a
-- Biblioteca da Presidência estava em manutenção: o 1º turno de 2026 foi
-- conferido por pessoa na tela de resultados do TSE; mandatos e eleições de
-- 2018/2022 vêm do registro público conhecido, com conferência interna
-- (percentuais = votos ÷ válidos) e ainda sem conferência humana na fonte.
-- As tolerâncias da conta (±1 ano; ±2% dos votos; ±1 p.p.) absorvem erro pequeno.
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
  conferencia text not null,
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
  conferencia text not null,
  unique (ano, turno, candidato)
);

alter table ref_mandatos enable row level security;
alter table ref_eleicoes enable row level security;

revoke all on ref_mandatos from anon, authenticated;
revoke all on ref_eleicoes from anon, authenticated;

-- Dados

insert into ref_mandatos (id, pessoa, partido, inicio, fim, papel, fonte_nome, fonte_url, trecho, conferencia, notas) values
  ('fhc-1995', 'Fernando Henrique Cardoso', 'PSDB', '1995-01-01', '2003-01-01', 'titular', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Posse em 1º/01/1995; reeleito em 1998; mandato até 1º/01/2003.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', null),
  ('lula-2003', 'Luiz Inácio Lula da Silva', 'PT', '2003-01-01', '2011-01-01', 'titular', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Posse em 1º/01/2003; reeleito em 2006; mandato até 1º/01/2011.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', null),
  ('dilma-2011', 'Dilma Rousseff', 'PT', '2011-01-01', '2016-05-12', 'titular', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Posse em 1º/01/2011; reeleita em 2014; afastada pelo Senado em 12/05/2016.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', 'Destituída pelo Senado em 31/08/2016.'),
  ('temer-interino-2016', 'Michel Temer', 'MDB', '2016-05-12', '2016-08-31', 'interino', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Exerceu a Presidência como interino de 12/05/2016 a 31/08/2016.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', 'Partido se chamava PMDB até dezembro de 2017.'),
  ('temer-2016', 'Michel Temer', 'MDB', '2016-08-31', '2019-01-01', 'titular', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Posse como presidente em 31/08/2016; mandato até 1º/01/2019.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', 'Partido se chamava PMDB até dezembro de 2017.'),
  ('bolsonaro-2019-psl', 'Jair Messias Bolsonaro', 'PSL', '2019-01-01', '2019-11-19', 'titular', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Posse em 1º/01/2019, filiado ao PSL.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', 'Data de saída do PSL (novembro de 2019) aproximada.'),
  ('bolsonaro-2019-sem-partido', 'Jair Messias Bolsonaro', 'sem partido', '2019-11-19', '2021-11-30', 'titular', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Sem partido de novembro de 2019 a 30/11/2021.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', 'Datas de desfiliação e filiação aproximadas em dias.'),
  ('bolsonaro-2021-pl', 'Jair Messias Bolsonaro', 'PL', '2021-11-30', '2023-01-01', 'titular', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Filiado ao PL em 30/11/2021; mandato até 1º/01/2023.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', null),
  ('lula-2023', 'Luiz Inácio Lula da Silva', 'PT', '2023-01-01', null, 'titular', 'Biblioteca da Presidência da República', 'https://www.biblioteca.presidencia.gov.br/presidencia/ex-presidentes', 'Posse em 1º/01/2023; mandato em curso.', 'registro público conhecido; não conferido por pessoa na fonte (Biblioteca em manutenção em 21/10/2026)', null)
on conflict (id) do update set
  pessoa = excluded.pessoa, partido = excluded.partido, inicio = excluded.inicio, fim = excluded.fim,
  papel = excluded.papel, fonte_nome = excluded.fonte_nome, fonte_url = excluded.fonte_url,
  trecho = excluded.trecho, conferencia = excluded.conferencia, notas = excluded.notas;

insert into ref_eleicoes (id, ano, turno, candidato, partido, votos, pct_validos, eleito, fonte_nome, fonte_url, trecho, conferencia) values
  ('2018-1-jair-bolsonaro', 2018, 1, 'Jair Bolsonaro', 'PSL', 49277010, 46.03, false, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'Jair Bolsonaro (PSL): 49.277.010 votos, 46,03% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2018-1-fernando-haddad', 2018, 1, 'Fernando Haddad', 'PT', 31342051, 29.28, false, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'Fernando Haddad (PT): 31.342.051 votos, 29,28% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2018-1-ciro-gomes', 2018, 1, 'Ciro Gomes', 'PDT', 13344371, 12.47, false, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'Ciro Gomes (PDT): 13.344.371 votos, 12,47% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2018-1-geraldo-alckmin', 2018, 1, 'Geraldo Alckmin', 'PSDB', 5096350, 4.76, false, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'Geraldo Alckmin (PSDB): 5.096.350 votos, 4,76% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2018-1-joao-amoedo', 2018, 1, 'João Amoêdo', 'NOVO', 2679745, 2.50, false, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'João Amoêdo (NOVO): 2.679.745 votos, 2,50% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2018-1-cabo-daciolo', 2018, 1, 'Cabo Daciolo', 'PATRIOTA', 1348323, 1.26, false, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'Cabo Daciolo (PATRIOTA): 1.348.323 votos, 1,26% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2018-1-henrique-meirelles', 2018, 1, 'Henrique Meirelles', 'MDB', 1288950, 1.20, false, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'Henrique Meirelles (MDB): 1.288.950 votos, 1,20% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2018-2-jair-bolsonaro', 2018, 2, 'Jair Bolsonaro', 'PSL', 57797847, 55.13, true, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'Jair Bolsonaro (PSL): 57.797.847 votos, 55,13% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2018-2-fernando-haddad', 2018, 2, 'Fernando Haddad', 'PT', 47040906, 44.87, false, 'TSE', 'https://www.tse.jus.br/eleicoes/estatisticas/estatisticas-eleitorais', 'Fernando Haddad (PT): 47.040.906 votos, 44,87% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2022-1-luiz-inacio-lula-da-silva', 2022, 1, 'Luiz Inácio Lula da Silva', 'PT', 57259504, 48.43, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Luiz Inácio Lula da Silva (PT): 57.259.504 votos, 48,43% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2022-1-jair-bolsonaro', 2022, 1, 'Jair Bolsonaro', 'PL', 51072345, 43.20, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Jair Bolsonaro (PL): 51.072.345 votos, 43,20% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2022-1-simone-tebet', 2022, 1, 'Simone Tebet', 'MDB', 4915423, 4.16, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Simone Tebet (MDB): 4.915.423 votos, 4,16% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2022-1-ciro-gomes', 2022, 1, 'Ciro Gomes', 'PDT', 3599287, 3.04, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Ciro Gomes (PDT): 3.599.287 votos, 3,04% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2022-2-luiz-inacio-lula-da-silva', 2022, 2, 'Luiz Inácio Lula da Silva', 'PT', 60345999, 50.90, true, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Luiz Inácio Lula da Silva (PT): 60.345.999 votos, 50,90% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2022-2-jair-bolsonaro', 2022, 2, 'Jair Bolsonaro', 'PL', 58206354, 49.10, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Jair Bolsonaro (PL): 58.206.354 votos, 49,10% dos votos válidos', 'registro público conhecido; percentuais conferidos por conta (votos ÷ válidos); não conferido por pessoa na fonte'),
  ('2026-1-flavio-bolsonaro', 2026, 1, 'Flávio Bolsonaro', 'PL', 56104503, 47.03, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Flávio Bolsonaro (PL): 56.104.503 votos, 47,03% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-luiz-inacio-lula-da-silva', 2026, 1, 'Luiz Inácio Lula da Silva', 'PT', 53879538, 45.16, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Luiz Inácio Lula da Silva (PT): 53.879.538 votos, 45,16% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-escritor-augusto-cury', 2026, 1, 'Escritor Augusto Cury', 'AVANTE', 3448569, 2.89, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Escritor Augusto Cury (AVANTE): 3.448.569 votos, 2,89% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-renan-santos', 2026, 1, 'Renan Santos', 'MISSÃO', 2675887, 2.24, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Renan Santos (MISSÃO): 2.675.887 votos, 2,24% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-ronaldo-caiado', 2026, 1, 'Ronaldo Caiado', 'PSD', 2605148, 2.18, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Ronaldo Caiado (PSD): 2.605.148 votos, 2,18% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-romeu-zema', 2026, 1, 'Romeu Zema', 'NOVO', 326488, 0.27, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Romeu Zema (NOVO): 326.488 votos, 0,27% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-samara', 2026, 1, 'Samara', 'UP', 122911, 0.10, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Samara (UP): 122.911 votos, 0,10% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-hertz-dias', 2026, 1, 'Hertz Dias', 'PSTU', 43103, 0.04, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Hertz Dias (PSTU): 43.103 votos, 0,04% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-clariana-barao', 2026, 1, 'Clariana Barão', 'DC', 40043, 0.03, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Clariana Barão (DC): 40.043 votos, 0,03% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-edmilson-costa', 2026, 1, 'Edmilson Costa', 'PCB', 22693, 0.02, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Edmilson Costa (PCB): 22.693 votos, 0,02% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-veterinario-wilson-grassi', 2026, 1, 'Veterinário Wilson Grassi', 'DEMOCRATA', 16881, 0.01, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Veterinário Wilson Grassi (DEMOCRATA): 16.881 votos, 0,01% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções'),
  ('2026-1-rui-costa-pimenta', 2026, 1, 'Rui Costa Pimenta', 'PCO', 15024, 0.01, false, 'TSE', 'https://resultados.tse.jus.br/oficial/app/index.html', 'Rui Costa Pimenta (PCO): 15.024 votos, 0,01% dos votos válidos', 'conferido por pessoa na tela de resultados do TSE (atualização de 05/10/2026 12:51:05), 100% das seções')
on conflict (id) do update set
  ano = excluded.ano, turno = excluded.turno, candidato = excluded.candidato, partido = excluded.partido,
  votos = excluded.votos, pct_validos = excluded.pct_validos, eleito = excluded.eleito,
  fonte_nome = excluded.fonte_nome, fonte_url = excluded.fonte_url, trecho = excluded.trecho,
  conferencia = excluded.conferencia;
