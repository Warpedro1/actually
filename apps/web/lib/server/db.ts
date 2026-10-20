import "server-only";
import { serviceClient } from "@actually/db";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../env";

/**
 * Cliente service role — usado SOMENTE nas rotas de ingest/controle, em
 * GET /api/alerts e nas rotas da carga da base (/api/kb/*, depois de conferir
 * o editor). Páginas usam a anon key + sessão (RLS).
 * Isolado neste módulo para os testes trocarem por um mock.
 */
export function getServiceClient(): SupabaseClient {
  return serviceClient();
}

/** Cliente anon com o JWT do usuário: o banco aplica RLS e is_editor() como esse usuário. */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}
