// Tipos e formatação do painel "Base de conhecimento" do /admin (cliente).
import type { KbCounts, KbJob } from "@actually/db";

/** Tarefa como GET /api/kb/status devolve (sem a fila de etapas; log só no fim). */
export type KbJobView = Pick<
  KbJob,
  | "id" | "preset" | "title" | "status" | "current_attempts" | "steps_done" | "steps_failed" | "steps_pending"
  | "log" | "created_at" | "started_at" | "finished_at" | "updated_at" | "lease_until"
> & { current_label: string | null };

export interface KbStatus {
  env: Record<string, boolean>;
  counts: KbCounts | null;
  counts_error: string | null;
  jobs: KbJobView[];
}

/** Situação da tarefa em português, com o tom do selo. */
export function jobState(j: Pick<KbJobView, "status" | "lease_until" | "steps_failed">, now: number): { text: string; tone: "neutral" | "ok" | "warn" | "bad" } {
  if (j.status === "done") return j.steps_failed ? { text: `concluída com ${j.steps_failed} falha(s)`, tone: "warn" } : { text: "concluída", tone: "ok" };
  if (j.status === "canceled") return { text: "cancelada", tone: "neutral" };
  const leased = j.lease_until !== null && Date.parse(j.lease_until) >= now;
  if (j.status === "queued") return { text: "na fila", tone: "neutral" };
  return leased ? { text: "rodando", tone: "ok" } : { text: "pausada entre rodadas", tone: "warn" };
}
