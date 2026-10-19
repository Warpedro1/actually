// Reconciliação do daemon: estado desejado (do /admin) × o que está rodando.
// Pura e testada — o daemon só executa a decisão.

import type { CaptureRole, MachineDesired, MachineReported } from "@actually/db";
import { buildSource } from "./args";
import type { SourceSpec } from "./audio";

export interface RunSpec {
  debate_slug: string;
  role: CaptureRole;
  source: SourceSpec;
}

export function specFromDesired(d: MachineDesired): { spec: RunSpec } | { error: string } {
  if (!d.debate_slug) return { error: "estado desejado sem debate_slug" };
  try {
    const source = buildSource({
      source: d.source,
      url: d.source === "youtube" ? d.url : undefined,
      // no desejado, url também carrega o caminho do arquivo (source=file)
      file: d.source === "file" ? d.url : undefined,
      device: d.device,
      realtime: true,
    });
    return { spec: { debate_slug: d.debate_slug, role: d.role ?? "primary", source } };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Identidade da configuração: mudou a chave ⇒ reinicia o runner. */
export function specKey(spec: RunSpec): string {
  return JSON.stringify([spec.debate_slug, spec.role, spec.source]);
}

export interface ReconcileInput {
  /** null = nunca recebeu (nem do disco) — não mexe em nada. */
  desired: MachineDesired | null;
  /** Agora no relógio do servidor (ms). */
  now: number;
  /** Chave do runner em execução, ou null. */
  runningKey: string | null;
  /** Chave de um replay de arquivo que terminou sozinho (não repetir). */
  completedKey: string | null;
  /** Após falha do runner, não reinicia antes disso (ms). */
  retryAt: number | null;
}

export type Decision =
  | { action: "idle" }
  | { action: "keep" }
  | { action: "wait"; until: number }
  | { action: "backoff"; until: number }
  | { action: "start"; spec: RunSpec; key: string }
  | { action: "restart"; spec: RunSpec; key: string }
  | { action: "stop"; reason: string }
  | { action: "invalid"; error: string }
  | { action: "completed" };

export function reconcile(i: ReconcileInput): Decision {
  const running = i.runningKey !== null;
  const d = i.desired;
  if (!d) return running ? { action: "keep" } : { action: "idle" };

  if (d.state === "stopped") return running ? { action: "stop", reason: "parada pedida no /admin" } : { action: "idle" };

  const stopAt = d.stop_at ? Date.parse(d.stop_at) : NaN;
  if (!Number.isNaN(stopAt) && i.now >= stopAt) {
    return running ? { action: "stop", reason: "stop_at atingido" } : { action: "idle" };
  }

  const r = specFromDesired(d);
  if ("error" in r) return running ? { action: "stop", reason: `configuração inválida: ${r.error}` } : { action: "invalid", error: r.error };
  const key = specKey(r.spec);

  const startAt = d.start_at ? Date.parse(d.start_at) : NaN;
  if (!Number.isNaN(startAt) && i.now < startAt) {
    return running ? { action: "stop", reason: "start_at adiado" } : { action: "wait", until: startAt };
  }

  if (running) return i.runningKey === key ? { action: "keep" } : { action: "restart", spec: r.spec, key };
  if (i.completedKey === key) return { action: "completed" };
  if (i.retryAt !== null && i.now < i.retryAt) return { action: "backoff", until: i.retryAt };
  return { action: "start", spec: r.spec, key };
}

/** Estado reportado quando não há runner vivo (com runner, vale o estado dele). */
export function idleReportedState(decision: Decision, lastError: string | null): MachineReported["state"] {
  switch (decision.action) {
    case "wait":
      return "waiting_start";
    case "backoff":
    case "invalid":
      return "error";
    case "start":
    case "restart":
      return "starting";
    case "stop":
      return "stopping";
    default:
      return lastError ? "error" : "idle";
  }
}

/** Diferença servidor − local (ms), estimada pelo meio da requisição. */
export function clockOffset(serverTimeIso: string, sentAt: number, receivedAt: number): number {
  const server = Date.parse(serverTimeIso);
  if (Number.isNaN(server)) return 0;
  return server - (sentAt + receivedAt) / 2;
}
