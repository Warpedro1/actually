-- Controle remoto da captura: a máquina roda `capture daemon` como serviço,
-- consulta /api/control/poll e obedece ao estado desejado definido no /admin.
-- Permite iniciar/parar/agendar a captura sem ninguém perto da máquina.

alter table debates add column scheduled_at timestamptz;

create table capture_machines (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  platform text,
  version text,
  -- definido pelo editor no /admin; ver MachineDesired em packages/db/src/types.ts
  desired jsonb not null default '{"state": "stopped"}'::jsonb,
  -- reportado pelo daemon a cada poll; ver MachineReported
  reported jsonb not null default '{}'::jsonb,
  last_seen timestamptz,
  desired_updated_at timestamptz not null default now(),
  desired_updated_by uuid references auth.users (id),
  created_at timestamptz not null default now()
);

create or replace function capture_machines_touch_desired() returns trigger
language plpgsql as $$
begin
  if new.desired is distinct from old.desired then
    new.desired_updated_at := now();
    new.desired_updated_by := coalesce(auth.uid(), new.desired_updated_by);
  end if;
  return new;
end;
$$;

create trigger capture_machines_touch_desired
  before update on capture_machines
  for each row execute function capture_machines_touch_desired();

alter table capture_machines enable row level security;
create policy capture_machines_editor_read on capture_machines for select using (is_editor());
create policy capture_machines_editor_update on capture_machines for update using (is_editor()) with check (is_editor());

alter publication supabase_realtime add table capture_machines;
