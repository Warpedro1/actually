import { after } from "next/server";
import { errorMessage, json, jsonError, serviceOr503 } from "@/lib/server/http";
import { checkCronSecret, createJob, runKb } from "@/lib/server/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Atualização diária da base (checagens recentes + indicadores + embeddings) se
 * ainda não houver uma hoje, e retomada de qualquer tarefa parada.
 *
 * O agendamento automático foi retirado do `vercel.json`: hoje a rota só roda
 * quando alguém a chama com `Authorization: Bearer CRON_SECRET` (ou quando um
 * agendamento for configurado de novo). A carga pelo /admin não depende dela —
 * encadeia as próprias rodadas.
 */
export async function GET(req: Request): Promise<Response> {
  if (!process.env.CRON_SECRET) return jsonError(503, "CRON_SECRET não configurado no servidor");
  if (!checkCronSecret(req)) return jsonError(401, "não autorizado");
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await svc.db
    .from("kb_jobs")
    .select("id")
    .eq("preset", "atualizacao-diaria")
    .gte("created_at", `${today}T00:00:00Z`)
    .limit(1);
  if (error) return jsonError(500, `kb_jobs: ${errorMessage(error)}`);
  let created: string | null = null;
  if (!(data ?? []).length) {
    try {
      created = (await createJob(svc.db, { preset: "atualizacao-diaria" }, null)).id;
    } catch (e) {
      return jsonError(500, errorMessage(e));
    }
  }
  after(() => runKb(new URL(req.url).origin));
  return json({ created });
}
