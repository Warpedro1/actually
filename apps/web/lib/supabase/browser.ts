"use client";

import { createBrowserClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isSupabaseConfigured, SUPABASE_ANON_KEY, SUPABASE_MISSING_MESSAGE, SUPABASE_URL } from "../env";

let publicClient: SupabaseClient | null = null;
let editorClient: SupabaseClient | null = null;

/**
 * Cliente anônimo das páginas públicas — sem sessão de propósito: mesmo que o
 * editor esteja logado no mesmo navegador, o feed público só vê o que a RLS
 * libera para anon.
 */
export function publicBrowserClient(): SupabaseClient {
  if (!isSupabaseConfigured()) throw new Error(SUPABASE_MISSING_MESSAGE);
  publicClient ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return publicClient;
}

/** Cliente com sessão do editor (cookies via @supabase/ssr) — /editor e /admin. */
export function editorBrowserClient(): SupabaseClient {
  if (!isSupabaseConfigured()) throw new Error(SUPABASE_MISSING_MESSAGE);
  editorClient ??= createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return editorClient;
}
