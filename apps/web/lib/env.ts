// Variáveis públicas (NEXT_PUBLIC_*) — inlinadas no bundle do cliente no build.
// Precisam ser referenciadas literalmente (process.env.NEXT_PUBLIC_X) para o Next substituir.

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const CONTACT = process.env.NEXT_PUBLIC_CONTACT ?? "";

export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

export const SUPABASE_MISSING_MESSAGE =
  "Supabase não configurado: defina NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY.";

/** Link de contato para reportar erro: aceita e-mail ou URL. */
export function contactHref(contact: string = CONTACT): string | null {
  const c = contact.trim();
  if (!c) return null;
  if (/^(https?:|mailto:)/i.test(c)) return c;
  if (c.includes("@")) return `mailto:${c}`;
  return null;
}
