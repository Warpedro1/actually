-- Retirada de alerta publicado ("alerta errado no ar").
--
-- (1) Rejeitar/retirar um alerta rejeita também as repetições dele
--     (repeat_of = ele), por qualquer caminho: /editor, SQL no painel, service role.
-- (2) Repetição nunca fica no ar com o original rejeitado, nem na corrida com o
--     pipeline (repetição inserida enquanto o editor retira o original).
-- (3) alert_retractions: sinal público, só com ids, de que um alerta saiu do ar.
--     O anon não enxerga o alerta rejeitado (RLS), então o UPDATE para
--     'rejected' não chega pelo Realtime a quem está no /ao-vivo; este INSERT
--     chega, e o cliente troca o card por um aviso neutro. Quem carrega a página
--     depois não recebe nada do alerta (GET /api/alerts só devolve o id em
--     retracted_ids, que o cliente usa para descartar).

create table alert_retractions (
  alert_id uuid primary key references alerts (id),
  debate_id uuid not null references debates (id),
  retracted_at timestamptz not null default now()
);
create index alert_retractions_debate on alert_retractions (debate_id, retracted_at);

-- Faz parte da trilha de auditoria: append-only.
create trigger alert_retractions_append_only before update or delete on alert_retractions
  for each row execute function forbid_mutation();

alter table alert_retractions enable row level security;
-- Público: só ids e horário (nada da afirmação, da correção ou do motivo).
create policy alert_retractions_read on alert_retractions for select using (true);
-- Escrita: só pelo trigger abaixo (security definer). Sem políticas de escrita.

-- ---------------------------------------------------------------------------
-- (1) + (3): depois da mudança de status
-- ---------------------------------------------------------------------------
create or replace function alerts_after_status_change() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    -- Cada repetição atualizada passa de novo por este trigger (sinal público
    -- e auditoria em alert_events, com o mesmo autor).
    update alerts
       set status = 'rejected',
           reject_reason = 'rejeitado junto com o original: '
             || coalesce(nullif(btrim(new.reject_reason), ''), 'sem motivo informado'),
           reviewed_by = coalesce(new.reviewed_by, reviewed_by),
           reviewed_at = coalesce(new.reviewed_at, now())
     where repeat_of = new.id
       and status <> 'rejected';
  end if;
  if old.status = 'published' and new.status <> 'published' then
    insert into alert_retractions (alert_id, debate_id)
    values (new.id, new.debate_id)
    on conflict (alert_id) do nothing;
  end if;
  return null;
end;
$$;

create trigger alerts_after_status_change
  after update on alerts
  for each row execute function alerts_after_status_change();

-- ---------------------------------------------------------------------------
-- (2): repetição segue o original rejeitado
-- ---------------------------------------------------------------------------
-- Roda antes de alerts_require_evidence (ordem alfabética dos triggers BEFORE).
create or replace function alerts_repeat_follows_original() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  orig_status alert_status;
begin
  if new.repeat_of is null or new.status = 'rejected' then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.status = old.status and new.repeat_of is not distinct from old.repeat_of then
    return new; -- só texto mudou
  end if;
  -- FOR SHARE espera uma retirada do original em andamento terminar e lê o
  -- status já confirmado: sem janela para a repetição escapar da cascata.
  select status into orig_status from alerts where id = new.repeat_of for share;
  if orig_status = 'rejected' then
    if tg_op = 'INSERT' then
      new.status := 'rejected';
      new.reject_reason := coalesce(new.reject_reason, 'original já rejeitado ou retirado');
    else
      raise exception 'repetição % não pode voltar: o original % foi rejeitado ou retirado', new.id, new.repeat_of
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger alerts_repeat_follows_original
  before insert or update on alerts
  for each row execute function alerts_repeat_follows_original();

-- Funções de trigger não são RPC.
revoke execute on function alerts_after_status_change() from public, anon, authenticated;
revoke execute on function alerts_repeat_follows_original() from public, anon, authenticated;

alter publication supabase_realtime add table alert_retractions;

-- ---------------------------------------------------------------------------
-- Dados existentes (ensaios): aplica as mesmas regras
-- ---------------------------------------------------------------------------
-- Repetições ainda de pé com o original já rejeitado (o trigger registra o sinal).
update alerts r
   set status = 'rejected',
       reject_reason = 'rejeitado junto com o original: ' || coalesce(nullif(btrim(o.reject_reason), ''), 'sem motivo informado'),
       reviewed_at = coalesce(o.reviewed_at, now())
  from alerts o
 where r.repeat_of = o.id
   and o.status = 'rejected'
   and r.status <> 'rejected';
-- Alertas que já estiveram no ar e saíram antes desta migration.
insert into alert_retractions (alert_id, debate_id, retracted_at)
select id, debate_id, coalesce(reviewed_at, now())
  from alerts
 where status <> 'published' and published_at is not null
on conflict (alert_id) do nothing;
