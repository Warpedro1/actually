-- Settings do debate gravadas por patch.
--
-- O /admin grava só as chaves que o editor mudou, aplicadas sobre o valor
-- ATUAL do banco (settings || patch). Antes, o formulário mandava o objeto
-- inteiro lido quando a aba abriu: uma aba aberta há horas desfazia em
-- silêncio o que outra sessão tinha mudado (ex.: desligava o HITL que o
-- responsável acabara de ligar).
--
-- p_expected traz, para cada chave do patch, o valor que a aba leu (null =
-- chave ausente). Se alguma delas mudou no banco desde então, nada é gravado
-- e a função falha com 40001: a aba recarrega e o editor decide de novo.
-- Chaves diferentes mudadas em sessões concorrentes são preservadas: o
-- merge acontece dentro do UPDATE, sob o lock da linha.
--
-- security invoker: roda com o papel de quem chama, sujeito à RLS de debates
-- (debates_editor_update exige is_editor()).
create or replace function set_debate_settings(p_debate_id uuid, p_patch jsonb, p_expected jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_settings jsonb;
  v_conflicts text;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'patch de settings vazio ou inválido' using errcode = '22023';
  end if;
  if p_expected is null or jsonb_typeof(p_expected) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_patch) k where not p_expected ? k) then
    raise exception 'p_expected precisa trazer o valor lido de cada chave do patch' using errcode = '22023';
  end if;

  update debates d
     set settings = d.settings || p_patch
   where d.id = p_debate_id
     and not exists (
       select 1 from jsonb_each(p_expected) e
        where coalesce(d.settings -> e.key, 'null'::jsonb) is distinct from e.value)
  returning d.settings into v_settings;
  if found then
    return v_settings;
  end if;

  -- Nada gravado: debate inexistente, sem permissão (RLS) ou conflito.
  select d.settings into v_settings from debates d where d.id = p_debate_id;
  if not found then
    raise exception 'debate inexistente' using errcode = 'P0002';
  end if;
  if not is_editor() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'sem permissão para alterar as configurações' using errcode = '42501';
  end if;
  select string_agg(e.key, ',' order by e.key) into v_conflicts
    from jsonb_each(p_expected) e
   where coalesce(v_settings -> e.key, 'null'::jsonb) is distinct from e.value;
  raise exception 'configurações mudaram em outra sessão: %', coalesce(v_conflicts, '?')
    using errcode = '40001', detail = coalesce(v_conflicts, '');
end;
$$;

-- Só usuários autenticados (a RLS ainda exige editor).
revoke execute on function set_debate_settings(uuid, jsonb, jsonb) from public, anon;
grant execute on function set_debate_settings(uuid, jsonb, jsonb) to authenticated;
