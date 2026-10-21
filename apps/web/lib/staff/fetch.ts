import type { SupabaseClient } from "@supabase/supabase-js";

/** Chama rotas do /admin (/api/kb/*, /api/ops/*) com o token da sessão do editor (o servidor confere is_editor e 2FA). */
export async function staffFetch<T>(client: SupabaseClient, path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("sessão expirada: entre de novo");
  const r = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), Authorization: `Bearer ${token}` },
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}
