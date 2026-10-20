"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Card, ErrorText, Field, inputCls, OkText, errMsg } from "./ui";

/** Código TOTP: 6 dígitos (aceita espaços colados do app). */
function cleanCode(v: string): string {
  return v.replace(/\D/g, "").slice(0, 6);
}

function CodeInput({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d{6}"
      maxLength={7}
      required
      value={value}
      onChange={(e) => onChange(cleanCode(e.target.value))}
      className={`${inputCls} text-center font-mono text-xl tracking-[0.4em]`}
    />
  );
}

/** Segundo fator no login (conta com TOTP cadastrado). */
export function MfaChallenge({
  client,
  onDone,
  onCancel,
}: {
  client: SupabaseClient;
  onDone: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: listErr } = await client.auth.mfa.listFactors();
    const factor = data?.totp[0];
    if (listErr || !factor) {
      setBusy(false);
      return setError(listErr ? errMsg(listErr) : "Nenhum autenticador verificado nesta conta.");
    }
    const { error: vErr } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    setBusy(false);
    if (vErr) {
      setCode("");
      return setError("Código inválido ou expirado. Tente o código atual do aplicativo.");
    }
    await onDone();
  }

  return (
    <Card title="Verificação em dois fatores">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Código de 6 dígitos do aplicativo autenticador" htmlFor="mfa-code">
          <CodeInput id="mfa-code" value={code} onChange={setCode} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" disabled={busy || code.length !== 6}>
          Verificar
        </Button>
        <Button variant="ghost" onClick={() => void onCancel()}>
          Sair
        </Button>
      </form>
    </Card>
  );
}

/** Cadastro de um app autenticador (TOTP): QR code → código de confirmação. */
export function MfaEnroll({ client, onDone }: { client: SupabaseClient; onDone: () => void | Promise<void> }) {
  const [pending, setPending] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    // Cadastros abandonados (não verificados) atrapalham um novo: remove antes.
    const { data: list } = await client.auth.mfa.listFactors();
    for (const f of list?.all ?? []) {
      if (f.factor_type === "totp" && f.status === "unverified") await client.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error: err } = await client.auth.mfa.enroll({
      factorType: "totp",
      // Nome que aparece no app autenticador. Sem ele o Supabase usa o host da
      // Site URL do Auth (que pode ainda ser localhost:3000).
      issuer: "actually",
      friendlyName: `actually ${new Date().toISOString().slice(0, 16)}`,
    });
    setBusy(false);
    if (err || !data) return setError(err ? errMsg(err) : "Falha ao iniciar o cadastro.");
    setPending({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setBusy(true);
    setError(null);
    const { error: err } = await client.auth.mfa.challengeAndVerify({ factorId: pending.id, code });
    setBusy(false);
    if (err) {
      setCode("");
      return setError(
        "Código não aceito. Use o código atual da entrada “actually” no app (não de outra conta) e confira se a hora do celular está automática.",
      );
    }
    setPending(null);
    await onDone();
  }

  if (!pending) {
    return (
      <div className="flex flex-col gap-3">
        <ErrorText>{error}</ErrorText>
        <Button variant="primary" onClick={() => void start()} disabled={busy}>
          Cadastrar aplicativo autenticador
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={confirm} className="flex flex-col gap-3">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>Abra o aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li>
        <li>
          No app, toque em <strong>+</strong> e escaneie o QR code <strong>de dentro do app</strong> (a câmera comum do celular não
          cadastra). Ou escolha “inserir chave” e digite a chave abaixo, tipo “baseada em tempo”.
        </li>
        <li>Digite o código de 6 dígitos que o app mostrar para “actually”.</li>
      </ol>
      {/* SVG em data: URI gerado pelo Supabase — <img> simples, sem next/image */}
      <img src={pending.qr} alt="QR code para o aplicativo autenticador" className="mx-auto h-48 w-48 rounded-lg bg-white p-2" />
      <p className="break-all rounded-lg bg-surface-2 p-2 text-center font-mono text-xs">{pending.secret}</p>
      <Field label="Código de confirmação" htmlFor="mfa-enroll-code">
        <CodeInput id="mfa-enroll-code" value={code} onChange={setCode} />
      </Field>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" variant="primary" disabled={busy || code.length !== 6}>
        Confirmar cadastro
      </Button>
    </form>
  );
}

/** Página /editor/seguranca: lista, cadastra e remove autenticadores. */
export function MfaManager({ client, requireMfa }: { client: SupabaseClient; requireMfa: boolean }) {
  const [factors, setFactors] = useState<{ id: string; name: string; created: string }[] | null>(null);
  const [aal, setAal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data, error: err }, { data: level }] = await Promise.all([
      client.auth.mfa.listFactors(),
      client.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    if (err) return setError(errMsg(err));
    setFactors((data?.totp ?? []).map((f) => ({ id: f.id, name: f.friendly_name ?? "Autenticador", created: f.created_at })));
    setAal(level?.currentLevel ?? null);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    if (requireMfa && (factors?.length ?? 0) <= 1) {
      return setError("Este ambiente exige 2FA: cadastre outro autenticador antes de remover o último.");
    }
    if (!window.confirm("Remover este autenticador? Ele deixará de ser pedido no login.")) return;
    const { error: err } = await client.auth.mfa.unenroll({ factorId: id });
    if (err) return setError(`${errMsg(err)} (remover exige sessão verificada com 2FA)`);
    setOk("Autenticador removido.");
    await load();
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-6">
      <Card title="Autenticação em dois fatores (TOTP)">
        <p className="text-sm text-muted">
          Com 2FA, entrar no editor/admin exige também um código do seu celular.{" "}
          {requireMfa ? (
            <strong className="text-fg">Neste ambiente o 2FA é obrigatório (REQUIRE_MFA=1).</strong>
          ) : (
            "Neste ambiente o 2FA é opcional, mas recomendado."
          )}
        </p>
        <p className="mt-2 text-xs text-muted">Nível da sessão atual: {aal === "aal2" ? "verificada com 2FA (aal2)" : "só senha/link (aal1)"}</p>
        <div className="mt-4 flex flex-col gap-2">
          {factors === null ? (
            <p className="text-sm text-muted">Carregando…</p>
          ) : factors.length === 0 ? (
            <p className="text-sm">Nenhum autenticador cadastrado.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {factors.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                  <span>
                    {f.name}
                    <span className="block text-xs text-muted">cadastrado em {new Date(f.created).toLocaleString("pt-BR")}</span>
                  </span>
                  <Button variant="danger" onClick={() => void remove(f.id)}>
                    Remover
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <ErrorText>{error}</ErrorText>
          <OkText>{ok}</OkText>
          {factors && factors.length === 0 ? (
            <MfaEnroll
              client={client}
              onDone={async () => {
                setOk("Autenticador cadastrado. Nos próximos acessos o código será pedido.");
                await load();
              }}
            />
          ) : null}
        </div>
      </Card>
    </div>
  );
}
