export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Usado pelo `capture doctor` para checar se a API está no ar. */
export function GET(): Response {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
