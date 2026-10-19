import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { getServiceClient } from "./db";

const NO_STORE = { "Cache-Control": "no-store" };

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });
}

export function jsonError(status: number, error: string, details?: unknown): Response {
  return json(details === undefined ? { error } : { error, details }, { status });
}

/** Lê e valida o corpo JSON; devolve 400 com os problemas do zod. */
export async function parseJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, response: jsonError(400, "corpo JSON inválido") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: jsonError(400, "requisição inválida", parsed.error.issues) };
  }
  return { ok: true, data: parsed.data };
}

/** Cliente service role ou 503 com mensagem clara (env ausente). */
export function serviceOr503(): { ok: true; db: SupabaseClient } | { ok: false; response: Response } {
  try {
    return { ok: true, db: getServiceClient() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api] Supabase indisponível:", msg);
    return { ok: false, response: jsonError(503, `servidor sem configuração do Supabase (${msg})`) };
  }
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
