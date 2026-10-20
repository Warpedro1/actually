import { AlertsQuery } from "@actually/db";
import { loadPublishedAlerts } from "@/lib/server/alerts";
import { requireEditor } from "@/lib/server/editorAuth";
import { errorMessage, jsonError, serviceOr503 } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Fallback do Realtime: alertas publicados + evidências + pessoa resolvida.
 * Cache curto de CDN — milhares de clientes no mesmo cursor viram 1 consulta a cada 2 s.
 *
 * Debate de teste não existe para o público (404). `?preview=1` com o token do
 * editor (Bearer) libera a prévia do /admin, sempre sem cache na CDN.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = AlertsQuery.safeParse({
    debate: url.searchParams.get("debate") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
  });
  if (!query.success) return jsonError(400, "parâmetros inválidos", query.error.issues);

  const preview = url.searchParams.get("preview") === "1";
  if (preview) {
    const auth = await requireEditor(req);
    if (!auth.ok) return auth.response;
  }

  const svc = serviceOr503();
  if (!svc.ok) return svc.response;

  try {
    const payload = await loadPublishedAlerts(svc.db, query.data.debate, query.data.since, { includeTest: preview });
    if (!payload) return jsonError(404, "debate não encontrado");
    return Response.json(payload, {
      headers: {
        "Cache-Control": preview ? "private, no-store" : "public, s-maxage=2, stale-while-revalidate=5",
      },
    });
  } catch (err) {
    console.error("[api/alerts]", err);
    return jsonError(500, `falha ao carregar alertas: ${errorMessage(err)}`);
  }
}
