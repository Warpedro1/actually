import { ReplayCreate } from "@actually/db";
import { after } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/server/editorAuth";
import { errorMessage, json, jsonError, parseJson, serviceOr503 } from "@/lib/server/http";
import { runKb } from "@/lib/server/kb";
import { createReplay, listPasses, ReplayError } from "@/lib/server/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// a primeira rodada da tarefa corre no after() desta rota
export const maxDuration = 300;

const DebateId = z.string().uuid();

/** Passadas da captura com trechos no debate (?debate=<id>), para o editor escolher o que reprocessar. */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireEditor(req);
  if (!auth.ok) return auth.response;
  const id = DebateId.safeParse(new URL(req.url).searchParams.get("debate"));
  if (!id.success) return jsonError(400, "parâmetro debate (id) ausente ou inválido");
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  try {
    return json({ passes: await listPasses(svc.db, id.data) });
  } catch (e) {
    return jsonError(500, errorMessage(e));
  }
}

/** Editor pede o reprocessamento: cria o debate de teste e a tarefa, e começa a rodar em segundo plano. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireEditor(req);
  if (!auth.ok) return auth.response;
  const body = await parseJson(req, ReplayCreate);
  if (!body.ok) return body.response;
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  try {
    const created = await createReplay(svc.db, body.data, auth.userId);
    after(() => runKb(new URL(req.url).origin));
    return json(created, { status: 201 });
  } catch (e) {
    if (e instanceof ReplayError) return jsonError(400, e.message);
    return jsonError(500, errorMessage(e));
  }
}
