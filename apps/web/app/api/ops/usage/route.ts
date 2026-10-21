import { cachedUsageReport } from "@/lib/server/apiUsage";
import { requireEditor } from "@/lib/server/editorAuth";
import { errorMessage, json, jsonError, serviceOr503 } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// cada provedor tem 5 s; a Anthropic pode paginar (3 consultas)
export const maxDuration = 30;

/**
 * Painel "Uso das APIs" do /admin: o que cada provedor informa (saldo, uso do
 * ciclo, custo) + o que o actually contou. Só editor; nunca devolve chave.
 * Cache de 60 s por instância; ?fresh=1 consulta de novo (botão Atualizar).
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireEditor(req);
  if (!auth.ok) return auth.response;
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  try {
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    return json(await cachedUsageReport(svc.db, fresh));
  } catch (e) {
    return jsonError(500, errorMessage(e));
  }
}
