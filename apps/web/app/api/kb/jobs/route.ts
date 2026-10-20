import { KbJobCreate } from "@actually/db";
import { PlanError } from "@actually/kb-ingest/jobs";
import { after } from "next/server";
import { requireEditor } from "@/lib/server/editorAuth";
import { errorMessage, json, jsonError, parseJson, serviceOr503 } from "@/lib/server/http";
import { createJob, runKb } from "@/lib/server/kb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// a primeira rodada da tarefa corre no after() desta rota
export const maxDuration = 300;

/** Editor pede uma carga no painel: grava a tarefa e começa a rodar em segundo plano. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireEditor(req);
  if (!auth.ok) return auth.response;
  const body = await parseJson(req, KbJobCreate);
  if (!body.ok) return body.response;
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  try {
    const job = await createJob(svc.db, body.data, auth.userId);
    after(() => runKb(new URL(req.url).origin));
    return json(job, { status: 201 });
  } catch (e) {
    if (e instanceof PlanError) return jsonError(400, e.message);
    return jsonError(500, errorMessage(e));
  }
}
