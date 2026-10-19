import { SegmentRequest, SegmentResponse } from "@actually/db";
import { runPipeline } from "@actually/pipeline";
import { after } from "next/server";
import { errorMessage, json, jsonError, parseJson, serviceOr503 } from "@/lib/server/http";
import { checkIngestToken } from "@/lib/server/ingestAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A resposta sai na hora; o pipeline (LLM + busca) roda em after() dentro deste orçamento.
export const maxDuration = 60;

/** Violação de unicidade (agent_id, seq) — retry de um segmento já gravado. */
const UNIQUE_VIOLATION = "23505";

export async function POST(req: Request): Promise<Response> {
  const denied = checkIngestToken(req);
  if (denied) return denied;
  const body = await parseJson(req, SegmentRequest);
  if (!body.ok) return body.response;
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  const { db } = svc;
  const seg = body.data;

  const { data: agent, error: agentErr } = await db
    .from("capture_agents")
    .select("id, debate_id, active")
    .eq("id", seg.agent_id)
    .maybeSingle<{ id: string; debate_id: string; active: boolean }>();
  if (agentErr) return jsonError(500, `falha ao buscar agente: ${errorMessage(agentErr)}`);
  if (!agent) return jsonError(404, "agente desconhecido — registre de novo");
  if (!agent.active) return json(SegmentResponse.parse({ status: "standby" }));

  const { data: row, error: insErr } = await db
    .from("segments")
    .insert({
      debate_id: agent.debate_id,
      agent_id: agent.id,
      seq: seg.seq,
      speaker_label: seg.speaker_label,
      text: seg.text,
      t_start: seg.t_start,
      t_end: seg.t_end,
      captured_at: seg.captured_at,
    })
    .select("id")
    .single<{ id: number | string }>();
  if (insErr) {
    if ((insErr as { code?: string }).code === UNIQUE_VIOLATION) {
      return json(SegmentResponse.parse({ status: "duplicate" }));
    }
    return jsonError(500, `falha ao gravar segmento: ${errorMessage(insErr)}`);
  }
  const segmentId = Number(row!.id);

  // Em segundo plano: erro no pipeline nunca derruba a resposta ao agente.
  after(async () => {
    const started = Date.now();
    try {
      const r = await runPipeline(segmentId);
      console.info(
        `[pipeline] segmento ${segmentId}: ${r.claims} afirmações, ${r.alerts} alertas em ${Date.now() - started} ms`,
      );
    } catch (err) {
      console.error(`[pipeline] segmento ${segmentId} falhou:`, err);
    }
  });

  return json(SegmentResponse.parse({ status: "accepted", segment_id: segmentId }));
}
