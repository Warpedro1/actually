// Gravação das settings do debate por patch: só as chaves que o editor mudou,
// aplicadas no banco sobre o valor ATUAL (RPC set_debate_settings, migration
// 20261019000006_settings_patch.sql). Nunca regrava o objeto inteiro lido
// quando a aba abriu, que pode estar obsoleto.

import type { DebateSettings } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SettingsKey = keyof DebateSettings;
export type SettingsPatch = Partial<DebateSettings>;

/** Chaves de revisão humana: desligar qualquer uma pede confirmação explícita. */
export const HITL_KEYS = ["require_red_approval", "require_yellow_approval"] as const satisfies readonly SettingsKey[];
export type HitlKey = (typeof HITL_KEYS)[number];

const HITL_TEXT: Record<HitlKey, string> = {
  require_red_approval: "dos VERMELHOS (🔴)",
  require_yellow_approval: "dos AMARELOS (🟡)",
};

/** Só as chaves em que `next` difere do que a aba carregou (`base`). */
export function settingsPatch(base: DebateSettings, next: DebateSettings): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(next) as SettingsKey[]) {
    if (next[k] !== base[k]) patch[k] = next[k];
  }
  return patch as SettingsPatch;
}

/** Valor que a aba leu do banco (bruto) para cada chave do patch; chave ausente = null. */
export function expectedFor(raw: Partial<DebateSettings> | null | undefined, patch: SettingsPatch): Record<string, unknown> {
  const read = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) out[k] = read[k] ?? null;
  return out;
}

/** Chaves HITL que o patch desliga. */
export function hitlTurnedOff(patch: SettingsPatch): HitlKey[] {
  return HITL_KEYS.filter((k) => patch[k] === false);
}

const show = (v: unknown) => (typeof v === "boolean" ? (v ? "ligado" : "desligado") : String(v));

/** Uma linha por chave alterada: "rótulo: antes → depois". */
export function describeChanges(base: DebateSettings, patch: SettingsPatch, labels: Partial<Record<SettingsKey, string>> = {}): string[] {
  return (Object.keys(patch) as SettingsKey[]).map((k) => `• ${labels[k] ?? k}: ${show(base[k])} → ${show(patch[k])}`);
}

/**
 * Textos dos diálogos de confirmação, na ordem: primeiro o que muda; depois,
 * se o patch desliga alguma revisão humana, uma confirmação só para isso.
 */
export function confirmMessages(base: DebateSettings, patch: SettingsPatch, labels: Partial<Record<SettingsKey, string>> = {}): string[] {
  const out = [
    [
      "Aplicar estas mudanças? Valem para todos os participantes a partir do próximo trecho.",
      "",
      ...describeChanges(base, patch, labels),
      "",
      "As demais configurações ficam como estão no banco.",
    ].join("\n"),
  ];
  const off = hitlTurnedOff(patch);
  if (off.length > 0) {
    out.push(
      [
        `ATENÇÃO: você vai DESLIGAR a revisão humana ${off.map((k) => HITL_TEXT[k]).join(" e ")}.`,
        "Esses alertas passam a ser publicados sem aprovação de um editor.",
        "",
        "Pelo runbook, só o responsável desliga o HITL, seguindo a tabela de decisão.",
        "Confirma o desligamento?",
      ].join("\n"),
    );
  }
  return out;
}

export type SaveSettingsResult =
  | { status: "unchanged" }
  | { status: "saved"; settings: Partial<DebateSettings> }
  /** Alguma chave do patch mudou no banco desde que a aba leu: nada foi gravado. */
  | { status: "conflict"; keys: string[] }
  | { status: "error"; message: string };

/** Grava o patch via RPC (merge no banco, recusado se as chaves mudaram desde a leitura). */
export async function saveSettingsPatch(
  client: SupabaseClient,
  debateId: string,
  raw: Partial<DebateSettings> | null | undefined,
  patch: SettingsPatch,
): Promise<SaveSettingsResult> {
  if (Object.keys(patch).length === 0) return { status: "unchanged" };
  const { data, error } = await client.rpc("set_debate_settings", {
    p_debate_id: debateId,
    p_patch: patch,
    p_expected: expectedFor(raw, patch),
  });
  if (error) {
    if (error.code === "40001") {
      const keys = (error.details ?? "").split(",").map((k) => k.trim()).filter(Boolean);
      return { status: "conflict", keys };
    }
    return { status: "error", message: error.message || String(error) };
  }
  return { status: "saved", settings: (data ?? {}) as Partial<DebateSettings> };
}
