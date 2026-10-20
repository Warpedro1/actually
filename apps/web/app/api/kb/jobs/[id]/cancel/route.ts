import { requireEditor } from "@/lib/server/editorAuth";
import { errorMessage, json, jsonError, serviceOr503 } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cancela uma tarefa na fila ou rodando; o executor para antes da próxima etapa. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireEditor(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return jsonError(400, "id inválido");
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  const now = new Date().toISOString();
  const { data, error } = await svc.db
    .from("kb_jobs")
    .update({ status: "canceled", finished_at: now, updated_at: now, lease_until: null })
    .eq("id", id)
    .in("status", ["queued", "running"])
    .select("id");
  if (error) return jsonError(500, `kb_jobs: ${errorMessage(error)}`);
  if (!(data ?? []).length) return jsonError(404, "tarefa não encontrada ou já terminada");
  return json({ id, status: "canceled" });
}
