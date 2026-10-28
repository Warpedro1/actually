"use client";

import { DEFAULT_SETTINGS, resolveSettings, type Debate, type DebateSettings } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent } from "react";
import { confirmMessages, saveSettingsPatch, settingsPatch, type SettingsKey } from "@/lib/staff/settings";
import { Button, Card, ErrorText, OkText, inputCls } from "./ui";

type BoolKey = { [K in keyof DebateSettings]: DebateSettings[K] extends boolean ? K : never }[keyof DebateSettings];
type NumKey = { [K in keyof DebateSettings]: DebateSettings[K] extends number ? K : never }[keyof DebateSettings];

const BOOLS: { key: BoolKey; label: string; help: string }[] = [
  {
    key: "require_red_approval",
    label: "Revisão humana dos vermelhos (HITL)",
    help: "Ligado: alertas 🔴 entram como pendentes e só aparecem depois que um editor aprova no /editor. Desligado: publicam sozinhos se passarem do limiar. Nunca há publicação automática por tempo esgotado.",
  },
  {
    key: "require_yellow_approval",
    label: "Revisão humana dos amarelos (HITL)",
    help: "Mesmo mecanismo para os alertas 🟡. Ligue se a fila de vermelhos estiver tranquila e quiser mais controle.",
  },
  {
    key: "show_attribution",
    label: "Mostrar o nome de quem falou",
    help: "Desligado (padrão): todo alerta diz “Afirmação feita no debate”. Ligado: mostra o nome só quando a voz foi mapeada no /editor (Lula, Flávio Bolsonaro, Mediação).",
  },
  {
    key: "web_search",
    label: "Busca na web",
    help: "Ligado (padrão): quando a base de conhecimento não tem fonte forte, o sistema também procura em sites confiáveis (níveis 1 e 2). Desligado: a base passa a ser a única fonte. A checagem fica mais rápida e não gasta créditos da Tavily, mas saem menos alertas. Sem a chave da Tavily no servidor, a busca já fica desligada.",
  },
];

const NUMS: { key: NumKey; label: string; help: string; min: number; max: number; step: number; unit?: string }[] = [
  { key: "t_red", label: "Limiar dos vermelhos (t_red)", help: "Score final mínimo para emitir 🔴. Mais alto = menos alertas, mais precisos.", min: 0, max: 1, step: 0.01 },
  { key: "t_yellow", label: "Limiar dos amarelos (t_yellow)", help: "Score final mínimo para emitir 🟡.", min: 0, max: 1, step: 0.01 },
  { key: "web_penalty", label: "Penalidade da busca web", help: "Somada ao limiar quando a melhor evidência veio da web (camada L4) ou de documento que a base aprendeu da web, o que acontece mesmo com a busca desligada; não vale para checagem de agência (nível 1) com trecho conferido.", min: 0, max: 0.5, step: 0.01 },
  { key: "dedup_similarity", label: "Similaridade da trava de repetição", help: "Afirmações com similaridade acima disto (e mesmos números) reusam o veredito anterior.", min: 0.5, max: 1, step: 0.01 },
  { key: "context_window_s", label: "Janela de contexto", help: "Segundos de transcrição anteriores enviados junto para a extração.", min: 0, max: 600, step: 5, unit: "s" },
  { key: "failover_after_s", label: "Failover da captura", help: "Sem heartbeat do agente ativo por este tempo, o banco promove o standby.", min: 3, max: 120, step: 1, unit: "s" },
];

const LABELS: Partial<Record<SettingsKey, string>> = Object.fromEntries([...BOOLS, ...NUMS].map((x) => [x.key, x.label]));

/** Formulário de settings do debate (vale para o próximo segmento processado). */
export function SettingsForm({ client, debate, onSaved }: { client: SupabaseClient; debate: Debate; onSaved: () => Promise<void> | void }) {
  const [s, setS] = useState<DebateSettings>(() => resolveSettings(debate.settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => setS(resolveSettings(debate.settings)), [debate]);

  async function save(e: FormEvent) {
    e.preventDefault();
    for (const n of NUMS) {
      const v = s[n.key];
      if (!Number.isFinite(v) || v < n.min || v > n.max) return setError(`${n.label}: valor entre ${n.min} e ${n.max}.`);
    }
    // Só o que mudou em relação ao que esta aba carregou; o banco aplica sobre o
    // valor atual e recusa se essas chaves mudaram em outra sessão.
    const base = resolveSettings(debate.settings);
    const patch = settingsPatch(base, s);
    if (Object.keys(patch).length === 0) {
      setError(null);
      return setOk("Nenhuma configuração foi alterada.");
    }
    for (const msg of confirmMessages(base, patch, LABELS)) {
      if (!window.confirm(msg)) return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    const r = await saveSettingsPatch(client, debate.id, debate.settings, patch);
    setBusy(false);
    if (r.status === "conflict") {
      const which = r.keys.map((k) => LABELS[k as SettingsKey] ?? k).join(", ") || "as configurações";
      setError(`Nada foi salvo: outra sessão mudou ${which} depois que esta aba carregou. Os valores atuais foram recarregados; revise e salve de novo.`);
      await onSaved();
      return;
    }
    if (r.status === "error") return setError(r.message);
    setOk("Configurações salvas.");
    await onSaved();
  }

  return (
    <Card id="config" title="Configurações do debate">
      <form onSubmit={save} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">Chaves</legend>
          {BOOLS.map((b) => (
            <label key={b.key} className="flex items-start gap-3 rounded-lg border border-border p-3">
              <input
                type="checkbox"
                checked={s[b.key]}
                onChange={(e) => setS({ ...s, [b.key]: e.target.checked })}
                className="mt-1 h-5 w-5 shrink-0 accent-current"
              />
              <span>
                <span className="block text-sm font-medium">
                  {b.label}{" "}
                  <span className="text-xs font-normal text-muted">(padrão: {DEFAULT_SETTINGS[b.key] ? "ligado" : "desligado"})</span>
                </span>
                <span className="block text-xs leading-snug text-muted">{b.help}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="sr-only">Valores</legend>
          {NUMS.map((n) => (
            <div key={n.key} className="flex flex-col gap-1">
              <label htmlFor={`set-${n.key}`} className="text-sm font-medium">
                {n.label}{" "}
                <span className="text-xs font-normal text-muted">
                  (padrão {DEFAULT_SETTINGS[n.key]}
                  {n.unit ?? ""})
                </span>
              </label>
              <input
                id={`set-${n.key}`}
                type="number"
                inputMode="decimal"
                min={n.min}
                max={n.max}
                step={n.step}
                value={Number.isFinite(s[n.key]) ? s[n.key] : ""}
                onChange={(e) => setS({ ...s, [n.key]: e.target.valueAsNumber })}
                className={inputCls}
              />
              <p className="text-xs leading-snug text-muted">{n.help}</p>
            </div>
          ))}
        </fieldset>
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            Salvar configurações
          </Button>
          <Button onClick={() => setS({ ...DEFAULT_SETTINGS })} disabled={busy}>
            Restaurar padrões
          </Button>
        </div>
      </form>
    </Card>
  );
}
