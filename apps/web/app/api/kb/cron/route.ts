import { after } from "next/server";
import { errorMessage, json, jsonError, serviceOr503 } from "@/lib/server/http";
import { checkCronSecret, createJob, runKb } from "@/lib/server/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Cron diário da Vercel (vercel.json, 09:00 UTC): agenda a atualização diária
 * (checagens recentes + indicadores + embeddings) se ainda não houver uma hoje,
 * e retoma qualquer tarefa parada. A Vercel manda `Authorization: Bearer CRON_SECRET`.
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
