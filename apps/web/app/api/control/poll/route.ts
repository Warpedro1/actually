import { ControlPollRequest, ControlPollResponse, MachineDesiredSchema } from "@actually/db";
import { errorMessage, json, jsonError, parseJson, serviceOr503 } from "@/lib/server/http";
import { checkIngestToken } from "@/lib/server/ingestAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/** Desejado inválido no banco nunca liga a captura por engano. */
const SAFE_DESIRED = { state: "stopped" as const };

/**
 * O daemon de captura chama a cada ~3 s: grava o estado reportado (upsert pelo
 * nome da máquina) e recebe o estado desejado definido no /admin.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = checkIngestToken(req);
  if (denied) return denied;
  const body = await parseJson(req, ControlPollRequest);
  if (!body.ok) return body.response;
  const svc = serviceOr503();
  if (!svc.ok) return svc.response;
  const { machine_name, platform, version, reported } = body.data;

  // Upsert sem `desired`: na criação vale o default do banco ({state: stopped});
  // na atualização o desejado definido pelo editor é preservado.
  const { data, error } = await svc.db
    .from("capture_machines")
    .upsert(
      { name: machine_name, platform, version, reported, last_seen: new Date().toISOString() },
      { onConflict: "name" },
    )
    .select("id, desired")
    .single<{ id: string; desired: unknown }>();
  if (error || !data) return jsonError(500, `falha ao registrar máquina: ${errorMessage(error)}`);

  const desired = MachineDesiredSchema.safeParse(data.desired);
  if (!desired.success) {
    console.warn(`[control] desejado inválido para "${machine_name}" — devolvendo stopped`, desired.error.issues);
  }

  return json(
    ControlPollResponse.parse({
      machine_id: data.id,
      desired: desired.success ? desired.data : SAFE_DESIRED,
      server_time: new Date().toISOString(),
    }),
  );
}
