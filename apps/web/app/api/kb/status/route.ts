import type { KbCounts } from "@actually/db";
import { after } from "next/server";
import { requireEditor } from "@/lib/server/editorAuth";
import { errorMessage, json, jsonError, serviceOr503 } from "@/lib/server/http";
import { kbEnv, needsRunner, runKb, stepLabel } from "@/lib/server/kb";
import type { KbJobView, KbStatus } from "@/lib/staff/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// o executor pode rodar no after() desta rota (retomada)
export const maxDuration = 300;

/** Linhas de log por tarefa na resposta (o banco guarda até 300). */
const LOG_TAIL = 80;

/**
 * Painel "Base de conhecimento" do /admin: tarefas recentes, chaves presentes
 * (só sim/não) e, com ?counts=1, o resumo da base. Se houver tarefa pendente sem
 * ninguém rodando (função caiu ou encadeamento falhou), retoma aqui.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireEditor(req);
  if (!auth.ok) return auth.response;
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  const url = new URL(req.url);

  const { data, error } = await svc.db
    .from("kb_jobs")
    .select("id, preset, title, status, current, current_attempts, steps_done, steps_failed, steps_pending, log, created_at, started_at, finished_at, updated_at, lease_until")
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) return jsonError(500, `kb_jobs: ${errorMessage(error)}`);
  const rows = (data ?? []) as (Omit<KbJobView, "current_label"> & { current: unknown })[];
  const jobs: KbJobView[] = rows.map(({ current, log, ...j }) => ({ ...j, log: (log ?? []).slice(-LOG_TAIL), current_label: stepLabel(current) }));

  let counts: KbCounts | null = null;
  let countsError: string | null = null;
  if (url.searchParams.get("counts") === "1") {
    const r = await svc.db.rpc("kb_counts");
    if (r.error) countsError = errorMessage(r.error);
    else counts = r.data as KbCounts;
  }

  if (needsRunner(jobs)) after(() => runKb(url.origin));
  const body: KbStatus = { env: kbEnv(), counts, counts_error: countsError, jobs };
  return json(body);
}
