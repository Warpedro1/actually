import "server-only";
import { userClient } from "./db";
import { jsonError } from "./http";
import { requireMfa } from "./staff";

/** Claims do JWT sem verificar a assinatura — só depois que o banco aceitou o token. */
function jwtClaims(token: string): { sub?: string; aal?: string } {
  try {
    const part = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { sub?: string; aal?: string };
  } catch {
    return {};
  }
}

/**
 * Rotas do /admin que usam o service role (carga da base): o navegador manda o
 * access token da sessão do editor em `Authorization: Bearer`. Quem decide é o
 * banco: is_editor() roda com esse JWT (assinatura conferida pelo Supabase) e já
 * exige 2FA quando editors.mfa_required. REQUIRE_MFA=1 exige aal2 de todos.
 */
export async function requireEditor(req: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return { ok: false, response: jsonError(401, "faça login no /admin") };
  const token = m[1]!;
  let client: ReturnType<typeof userClient>;
  try {
    client = userClient(token);
  } catch {
    return { ok: false, response: jsonError(503, "Supabase não configurado no servidor") };
  }
  const { data, error } = await client.rpc("is_editor");
  if (error) return { ok: false, response: jsonError(401, "sessão inválida ou expirada; entre de novo") };
  if (data !== true) return { ok: false, response: jsonError(403, "acesso só para editores (com 2FA, se exigido)") };
  const claims = jwtClaims(token);
  if (requireMfa() && claims.aal !== "aal2") return { ok: false, response: jsonError(403, "confirme o código do autenticador (2FA)") };
  if (!claims.sub) return { ok: false, response: jsonError(401, "sessão sem usuário") };
  return { ok: true, userId: claims.sub };
}
