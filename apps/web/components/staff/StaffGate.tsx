"use client";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { isSupabaseConfigured, SUPABASE_MISSING_MESSAGE } from "@/lib/env";
import { editorBrowserClient } from "@/lib/supabase/browser";
import { MfaChallenge, MfaEnroll } from "./Mfa";
import { Button, Card, ErrorText, Field, inputCls, OkText, errMsg } from "./ui";

export interface StaffContext {
  client: SupabaseClient;
  user: User;
  signOut: () => Promise<void>;
}

type Phase =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "mfa-challenge" }
  | { kind: "mfa-enroll-required" }
  | { kind: "not-editor"; user: User }
  | { kind: "ready"; user: User }
  | { kind: "error"; message: string };

/**
 * Porta das áreas restritas: login (senha ou link mágico) → 2FA (se a conta
 * tem fator TOTP, ou se REQUIRE_MFA=1) → precisa estar em `editors`.
 * A segurança de verdade está na RLS do banco; isto é a experiência.
 */
export function StaffGate({
  requireMfa,
  allowWithoutEditor = false,
  children,
}: {
  requireMfa: boolean;
  /** /editor/seguranca: permite cadastrar 2FA antes de virar editor. */
  allowWithoutEditor?: boolean;
  children: (ctx: StaffContext) => ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const configured = isSupabaseConfigured();
  // Criado só no navegador (o cliente de sessão lê cookies do document).
  const [client, setClient] = useState<SupabaseClient | null>(null);
  useEffect(() => {
    if (configured) setClient(editorBrowserClient());
  }, [configured]);

  const evaluate = useCallback(async () => {
    if (!client) return;
    const { data: userData } = await client.auth.getUser();
    const user = userData.user;
    if (!user) return setPhase({ kind: "signed-out" });

    const { data: aal, error: aalErr } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalErr) return setPhase({ kind: "error", message: errMsg(aalErr) });
    if (aal.currentLevel !== "aal2") {
      if (aal.nextLevel === "aal2") return setPhase({ kind: "mfa-challenge" });
      if (requireMfa) return setPhase({ kind: "mfa-enroll-required" });
    }

    const { data: isEditor, error } = await client.rpc("is_editor");
    if (error) return setPhase({ kind: "error", message: `Falha ao verificar permissão: ${errMsg(error)}` });
    if (!isEditor && !allowWithoutEditor) return setPhase({ kind: "not-editor", user });
    setPhase({ kind: "ready", user });
  }, [client, requireMfa, allowWithoutEditor]);

  useEffect(() => {
    if (!client) return;
    void evaluate();
    const { data } = client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "MFA_CHALLENGE_VERIFIED") void evaluate();
    });
    return () => data.subscription.unsubscribe();
  }, [client, evaluate]);

  const signOut = useCallback(async () => {
    await client?.auth.signOut();
    setPhase({ kind: "signed-out" });
  }, [client]);

  if (!configured) {
    return (
      <Shell>
        <ErrorText>{SUPABASE_MISSING_MESSAGE}</ErrorText>
      </Shell>
    );
  }

  if (!client || phase.kind === "loading") {
    return (
      <Shell>
        <p className="text-sm text-muted">Verificando acesso…</p>
      </Shell>
    );
  }

  switch (phase.kind) {
    case "signed-out":
      return (
        <Shell>
          <LoginForm client={client} />
        </Shell>
      );
    case "mfa-challenge":
      return (
        <Shell>
          <MfaChallenge client={client} onDone={evaluate} onCancel={signOut} />
        </Shell>
      );
    case "mfa-enroll-required":
      return (
        <Shell>
          <Card title="Autenticação em dois fatores obrigatória">
            <p className="mb-4 text-sm text-muted">
              Este ambiente exige 2FA (REQUIRE_MFA=1). Cadastre um aplicativo autenticador para continuar.
            </p>
            <MfaEnroll client={client} onDone={evaluate} />
            <Button variant="ghost" className="mt-3" onClick={() => void signOut()}>
              Sair
            </Button>
          </Card>
        </Shell>
      );
    case "not-editor":
      return (
        <Shell>
          <Card title="Sem acesso de editor">
            <p className="text-sm">
              A conta <strong>{phase.user.email}</strong> entrou, mas não está na lista de editores. Peça a um
              administrador para incluir seu usuário na tabela <code>editors</code>.
            </p>
            <p className="mt-2 text-xs text-muted">ID do usuário: {phase.user.id}</p>
            <Button className="mt-4" onClick={() => void signOut()}>
              Sair
            </Button>
          </Card>
        </Shell>
      );
    case "error":
      return (
        <Shell>
          <ErrorText>{phase.message}</ErrorText>
          <Button className="mt-3" onClick={() => void evaluate()}>
            Tentar de novo
          </Button>
        </Shell>
      );
    case "ready":
      return (
        <>
          <StaffNav email={phase.user.email ?? ""} onSignOut={signOut} />
          {children({ client, user: phase.user, signOut })}
        </>
      );
  }
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-md px-4 py-10">{children}</div>;
}

function StaffNav({ email, onSignOut }: { email: string; onSignOut: () => Promise<void> }) {
  const path = usePathname();
  const link = (href: string, label: string) => (
    <Link
      href={href}
      aria-current={path === href ? "page" : undefined}
      className={`rounded-md px-2.5 py-1.5 ${path === href ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="border-b border-border bg-surface-2">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-1 px-4 py-2 text-sm">
        {link("/editor", "Editor")}
        {link("/admin", "Admin")}
        {link("/editor/seguranca", "Segurança")}
        <span className="ml-auto truncate text-xs text-muted">{email}</span>
        <Button variant="ghost" onClick={() => void onSignOut()}>
          Sair
        </Button>
      </div>
    </div>
  );
}

function LoginForm({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function withPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await client.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (err) setError(err.message === "Invalid login credentials" ? "E-mail ou senha incorretos." : err.message);
  }

  async function magicLink() {
    if (!email) return setError("Informe o e-mail.");
    setBusy(true);
    setError(null);
    const { error: err } = await client.auth.signInWithOtp({
      email,
      // Sem cadastro aberto: só entra quem já tem conta.
      options: { shouldCreateUser: false, emailRedirectTo: window.location.href },
    });
    setBusy(false);
    if (err) setError(err.message);
    else setSent(`Enviamos um link de acesso para ${email}. Abra-o neste mesmo navegador.`);
  }

  return (
    <Card title="Acesso restrito">
      <form onSubmit={withPassword} className="flex flex-col gap-3">
        <Field label="E-mail" htmlFor="login-email">
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Senha" htmlFor="login-password">
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </Field>
        <ErrorText>{error}</ErrorText>
        <OkText>{sent}</OkText>
        <Button type="submit" variant="primary" disabled={busy || !password}>
          Entrar
        </Button>
        <Button onClick={() => void magicLink()} disabled={busy}>
          Enviar link mágico por e-mail
        </Button>
      </form>
    </Card>
  );
}
