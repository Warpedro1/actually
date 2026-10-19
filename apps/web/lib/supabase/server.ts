import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isSupabaseConfigured, SUPABASE_ANON_KEY, SUPABASE_URL } from "../env";

/**
 * Cliente anônimo para Server Components públicos (sem cookies → a página pode
 * ser cacheada/ISR). Retorna null sem configuração; a página mostra o erro.
 */
export function publicServerClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
