import { HeartbeatRequest, HeartbeatResponse } from "@actually/db";
import { errorMessage, json, jsonError, parseJson, serviceOr503 } from "@/lib/server/http";
import { checkIngestToken } from "@/lib/server/ingestAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/** A cada ~2 s. O banco decide (failover atômico) e responde se este agente é o ativo. */
export async function POST(req: Request): Promise<Response> {
  const denied = checkIngestToken(req);
  if (denied) return denied;
  const body = await parseJson(req, HeartbeatRequest);
  if (!body.ok) return body.response;
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;

  const { data, error } = await svc.db.rpc("capture_heartbeat", { p_agent_id: body.data.agent_id });
  if (error) {
    const msg = errorMessage(error);
    if (/não existe/.test(msg)) return jsonError(404, "agente desconhecido — registre de novo");
    return jsonError(500, `falha no heartbeat: ${msg}`);
  }
  return json(HeartbeatResponse.parse({ active: data === true }));
}
