-- Remover agente de captura pelo /admin (tentativas que falharam, testes): cada
-- `capture run` registra um agente novo, e os que nunca gravaram fala só poluem a
-- lista de agentes do debate.
--
-- Só sai agente PARADO e SEM FALAS:
-- - parado = sem heartbeat no último minuto (ou na janela de failover, se maior).
--   Apagar um agente vivo derruba a captura: o próximo heartbeat dele falha.
-- - sem falas = nenhum segmento dele. `segments` é trilha de auditoria (append-only)
--   e aponta para o agente; a FK já impediria, aqui a recusa vem com mensagem clara.
-- Só editor (is_editor(), com 2FA quando exigido) ou service role. Não destrutiva:
-- só cria a função.

create or replace function capture_agent_delete(p_agent_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_agent capture_agents%rowtype;
  v_window interval;
  v_segments bigint;
  v_deleted int;
begin
  if not is_editor() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  select * into v_agent from capture_agents where id = p_agent_id;
  if not found then
    raise exception 'agente não existe' using errcode = 'P0002';
  end if;
  -- mesma trava do heartbeat/failover e da troca manual de agente ativo
  perform pg_advisory_xact_lock(hashtext(v_agent.debate_id::text));
  select make_interval(secs => greatest(coalesce((settings ->> 'failover_after_s')::numeric, 10), 60))
    into v_window from debates where id = v_agent.debate_id;

  select * into v_agent from capture_agents where id = p_agent_id;
  if not found then
    raise exception 'agente não existe' using errcode = 'P0002';
  end if;
  if v_agent.last_heartbeat is not null and v_agent.last_heartbeat > now() - v_window then
    raise exception 'o agente "%" está em uso (deu sinal no último minuto): pare a captura antes de remover', v_agent.name
      using errcode = '55006';
  end if;
  select count(*) into v_segments from segments where agent_id = p_agent_id;
  if v_segments > 0 then
    raise exception 'o agente "%" gravou % trecho(s) de fala: fica no registro de auditoria', v_agent.name, v_segments
      using errcode = '23503';
  end if;

  -- o heartbeat atualiza a linha antes de pegar a trava: se ele chegar agora, a condição
  -- é reavaliada depois da espera pela linha e nada é apagado
  delete from capture_agents
  where id = p_agent_id and (last_heartbeat is null or last_heartbeat <= now() - v_window);
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'o agente "%" voltou a dar sinal: não foi removido', v_agent.name using errcode = '55006';
  end if;
  return v_agent.name;
end;
$$;

revoke execute on function capture_agent_delete(uuid) from public, anon;
grant execute on function capture_agent_delete(uuid) to authenticated, service_role;
