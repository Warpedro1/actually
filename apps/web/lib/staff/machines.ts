// Saúde das máquinas de captura (painel remoto do /admin). Funções puras.

import type { CaptureAgent, CaptureMachine, MachineDesired, MachineReported } from "@actually/db";
import { formatDuration, formatTime, secondsSince } from "../format";

/** Sem poll há mais que isso → offline. */
export const ONLINE_WINDOW_S = 10;
/** Nível abaixo disso conta como silêncio (dBFS). */
export const SILENCE_DB = -60;
/** Silêncio por mais que isso, capturando → alerta visual. */
export const SILENCE_ALERT_S = 20;
/** Sugestão de início da captura antes do horário do debate. */
export const START_LEAD_MIN = 15;

export const REPORTED_TEXT: Record<MachineReported["state"], string> = {
  idle: "Parada",
  waiting_start: "Aguardando horário",
  starting: "Iniciando",
  running: "Capturando",
  stopping: "Parando",
  error: "Erro",
};

export const SOURCE_TEXT = { youtube: "YouTube", device: "Dispositivo de áudio", file: "Arquivo" } as const;

export function machineOnline(m: Pick<CaptureMachine, "last_seen">, now: number): boolean {
  const s = secondsSince(m.last_seen, now);
  return s !== null && s < ONLINE_WINDOW_S;
}

/** É o agente ativo do debate (pelo reportado ou pelo capture_agents). */
export function isActiveMachine(m: Pick<CaptureMachine, "reported">, agents: readonly CaptureAgent[]): boolean {
  if (m.reported.active) return true;
  const id = m.reported.agent_id;
  return !!id && agents.some((a) => a.id === id && a.active);
}

/**
 * Há quanto tempo a máquina está sem áudio útil: o maior entre "nível abaixo
 * de SILENCE_DB desde `silentSince`" e "sem segmento desde last_segment_at".
 * Só faz sentido capturando; senão, null.
 */
export function silenceSeconds(m: Pick<CaptureMachine, "reported">, now: number, silentSince: number | null): number | null {
  if (m.reported.state !== "running") return null;
  const byLevel = silentSince !== null ? Math.round((now - silentSince) / 1000) : 0;
  const bySegment = secondsSince(m.reported.last_segment_at ?? null, now) ?? 0;
  const s = Math.max(byLevel, bySegment);
  return s > 0 ? s : 0;
}

/** Nível desconhecido (null) não conta como silêncio — aí vale o último segmento. */
export function isSilentLevel(db: number | null | undefined): boolean {
  return typeof db === "number" && db <= SILENCE_DB;
}

export interface MachineWarning {
  tone: "bad" | "warn";
  text: string;
}

export function machineWarnings(
  m: CaptureMachine,
  agents: readonly CaptureAgent[],
  now: number,
  silentSince: number | null,
): MachineWarning[] {
  const out: MachineWarning[] = [];
  const online = machineOnline(m, now);
  const active = isActiveMachine(m, agents);
  const seen = secondsSince(m.last_seen, now);
  if (!online && active) {
    out.push({
      tone: "bad",
      text: `Máquina ATIVA offline há ${formatDuration(seen)}. O failover promove o standby automaticamente; se não acontecer, torne outro agente ativo.`,
    });
  } else if (!online && m.desired.state === "running") {
    out.push({ tone: "warn", text: `Offline há ${formatDuration(seen)} — deveria estar capturando.` });
  }
  if (online) {
    const silence = silenceSeconds(m, now, silentSince);
    if (silence !== null && silence > SILENCE_ALERT_S) {
      out.push({ tone: active ? "bad" : "warn", text: `Áudio em silêncio há ${formatDuration(silence)}.` });
    }
  }
  // Erro reportado aparece mesmo offline: é o último relato antes de sumir.
  if (m.reported.state === "error") {
    out.push({ tone: "bad", text: m.reported.error ? `Erro: ${m.reported.error}` : "Erro na captura." });
  }
  return out;
}

/** -60 dB → 0%, 0 dB → 100%. */
export function audioPercent(db: number | null | undefined): number {
  if (db === null || db === undefined || !Number.isFinite(db)) return 0;
  return Math.round(Math.min(1, Math.max(0, (db - SILENCE_DB) / -SILENCE_DB)) * 100);
}

/** start_at sugerido = scheduled_at − 15 min (null se o debate não tem horário). */
export function suggestStartAt(scheduledAt: string | null | undefined): string | null {
  if (!scheduledAt) return null;
  const t = Date.parse(scheduledAt);
  if (Number.isNaN(t)) return null;
  return new Date(t - START_LEAD_MIN * 60_000).toISOString();
}

export function describeDesired(d: MachineDesired): string {
  if (d.state === "stopped") return "Parada";
  const parts = [`Capturar /${d.debate_slug ?? "?"}`];
  if (d.source) parts.push(`via ${SOURCE_TEXT[d.source]}`);
  if (d.role) parts.push(`(${d.role === "primary" ? "principal" : "standby"})`);
  if (d.start_at) parts.push(`· início ${formatTime(d.start_at)}`);
  if (d.stop_at) parts.push(`· fim ${formatTime(d.stop_at)}`);
  return parts.join(" ");
}
