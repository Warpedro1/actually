import { after } from "next/server";
import { json, jsonError } from "@/lib/server/http";
import { checkCronSecret, runKb } from "@/lib/server/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Continuação da carga: cada invocação roda etapas por até ~3 min e, se sobrar
 * trabalho, chama esta rota de novo. Só com o CRON_SECRET (nunca pelo navegador).
 */
export async function POST(req: Request): Promise<Response> {
  if (!process.env.CRON_SECRET) return jsonError(503, "CRON_SECRET não configurado no servidor");
  if (!checkCronSecret(req)) return jsonError(401, "não autorizado");
  after(() => runKb(new URL(req.url).origin));
  return json({ accepted: true }, { status: 202 });
}
