-- Aviso público por debate e procedência da checagem.
--
-- O debate da Band foi checado por replay do áudio, depois do fato, e publicado
-- com a base já maior do que era na noite da transmissão — havia checagens de
-- agências publicadas no intervalo. O público precisa saber disso, e o site não
-- tem como adivinhar:
-- - started_at fica nulo quando o editor não passa por "ao vivo";
-- - ended_at é a hora do clique (neste debate, 33 h depois do último segmento);
-- - alertas nascem antes e depois do fim, porque o editor aprova a fila horas
--   depois e o pipeline pode ser reexecutado;
-- - com source = 'file', segments.captured_at é o relógio do replay.
-- Toda derivação possível rotularia este debate como "checado ao vivo", que é o
-- oposto da verdade. Então é declaração do editor, não inferência.
--
-- check_mode é enum de texto porque existe um terceiro caso real (parte ao vivo,
-- parte depois) e um quarto (não informado = nulo, e o site não afirma nada).
-- Não destrutiva: só colunas novas, nulas por padrão.

alter table debates add column if not exists public_note text
  check (public_note is null or char_length(public_note) <= 500);

comment on column debates.public_note is
  'Observação do editor exibida na página pública do debate (até 500 caracteres). O /admin escreve direto na tabela pelo navegador, então o limite tem de valer no banco.';

alter table debates add column if not exists check_mode text
  check (check_mode is null or check_mode in ('live', 'post', 'mixed'));

comment on column debates.check_mode is
  'Procedência da checagem, declarada pelo editor: live (ao vivo), post (publicada depois do debate), mixed (parte ao vivo, parte depois). Nulo = não informado, e a página não afirma nada.';

-- O caso que motivou a coluna.
update debates set check_mode = 'post' where slug = 'lula-vs-flavio-band' and check_mode is null;
