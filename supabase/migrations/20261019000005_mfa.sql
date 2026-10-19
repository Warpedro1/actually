-- 2FA aplicado no banco (RF14).
-- Antes, REQUIRE_MFA só valia na interface (StaffGate): quem tivesse apenas a
-- senha de um editor recebia um JWT aal1 e agia como editor direto pela API
-- (PostgREST/RPC), sem passar pelo /editor.
--
-- Agora, quando o editor tem mfa_required = true, toda permissão de editor
-- (is_editor(), usado em todas as políticas de RLS e em capture_set_active)
-- só vale com sessão verificada por TOTP: auth.jwt() ->> 'aal' = 'aal2'.
--
-- Operação: depois que o editor cadastrar o TOTP (em /editor/seguranca),
-- marcar `update editors set mfa_required = true where user_id = '<uuid>';`.
-- Marcar antes do cadastro não tranca a conta: o /editor leva ao cadastro do
-- autenticador, que não depende de is_editor().
--
-- O editor não consegue desmarcar a própria flag: `editors` só tem política de
-- SELECT (editors_self); escrita só pelo service role / SQL Editor.

alter table editors add column mfa_required boolean not null default false;

comment on column editors.mfa_required is
  'true → permissões de editor (is_editor) só valem com sessão aal2 (TOTP). Marcar depois do cadastro do TOTP.';

create or replace function is_editor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from editors e
    where e.user_id = auth.uid()
      and (not e.mfa_required or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
  );
$$;
