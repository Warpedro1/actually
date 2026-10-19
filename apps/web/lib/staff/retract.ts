// Retirada de alerta publicado pelo /editor (runbook: "Alerta errado publicado").
// O banco garante o resto: as repetições saem junto (trigger), o público deixa
// de ler o alerta (RLS) e quem está no /ao-vivo recebe o sinal em
// alert_retractions (Realtime) e em retracted_ids (GET /api/alerts).

import type { SupabaseClient } from "@supabase/supabase-js";

export type RetractResult = { ok: true } | { ok: false; error: string };

export async function retractAlert(
  client: Pick<SupabaseClient, "from">,
  input: { alertId: string; userId: string; reason: string },
  now: () => Date = () => new Date(),
): Promise<RetractResult> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, error: "Informe o motivo da retirada." };
  const { data, error } = await client
    .from("alerts")
    .update({ status: "rejected", reject_reason: reason, reviewed_by: input.userId, reviewed_at: now().toISOString() })
    .eq("id", input.alertId)
    .eq("status", "published")
    .select("id");
  if (error) {
    const msg = typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
    return { ok: false, error: `O banco recusou: ${msg}` };
  }
  if (!data?.length) return { ok: false, error: "Este alerta já não está publicado (outra pessoa pode ter retirado)." };
  return { ok: true };
}
