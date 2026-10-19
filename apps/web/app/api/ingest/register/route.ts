import { RegisterAgentRequest, RegisterAgentResponse } from "@actually/db";
import { errorMessage, json, jsonError, parseJson, serviceOr503 } from "@/lib/server/http";
import { checkIngestToken } from "@/lib/server/ingestAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/** Capture agent se apresenta: cria o registro em capture_agents e já manda o 1º heartbeat. */
export async function POST(req: Request): Promise<Response> {
  const denied = checkIngestToken(req);
  if (denied) return denied;
  const body = await parseJson(req, RegisterAgentRequest);
  if (!body.ok) return body.response;
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  const { db } = svc;
  const { debate_slug, name, source, role } = body.data;

  const { data: debate, error: debateErr } = await db
    .from("debates")
    .select("id")
    .eq("slug", debate_slug)
    .maybeSingle<{ id: string }>();
  if (debateErr) return jsonError(500, `falha ao buscar debate: ${errorMessage(debateErr)}`);
  if (!debate) return jsonError(404, `debate "${debate_slug}" não existe`);

  const { data: agent, error: agentErr } = await db
    .from("capture_agents")
    .insert({ debate_id: debate.id, name, source, role })
    .select("id")
    .single<{ id: string }>();
  if (agentErr || !agent) return jsonError(500, `falha ao registrar agente: ${errorMessage(agentErr)}`);

  const { error: hbErr } = await db.rpc("capture_heartbeat", { p_agent_id: agent.id });
  if (hbErr) console.error("[ingest/register] heartbeat inicial falhou:", errorMessage(hbErr));

  return json(RegisterAgentResponse.parse({ agent_id: agent.id, debate_id: debate.id }));
}
