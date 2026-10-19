import "server-only";
import { serviceClient } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente service role — usado SOMENTE nas rotas de ingest/controle e em
 * GET /api/alerts. Páginas usam a anon key + sessão (RLS).
 * Isolado neste módulo para os testes trocarem por um mock.
 */
export function getServiceClient(): SupabaseClient {
  return serviceClient();
}
