import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`variável de ambiente ausente: ${name}`);
  return v;
}

let service: SupabaseClient | null = null;

/** Cliente com service role — só no servidor (pipeline, ingest, kb-ingest). Bypassa RLS. */
export function serviceClient(): SupabaseClient {
  if (!service) {
    service = createClient(
      process.env.SUPABASE_URL ?? required("NEXT_PUBLIC_SUPABASE_URL"),
      required("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return service;
}

/** Cliente anônimo — sujeito a RLS (só lê o que foi publicado). */
export function anonClient(): SupabaseClient {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
}

/** pgvector aceita o literal '[1,2,3]'. */
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
