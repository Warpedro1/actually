import { resolveSettings, type Alert, type DebateSettings } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attributionFrom, buildFeed, type AlertsPayload, type FeedDebate } from "../feed";

/** Limite por resposta — o cliente pagina via `since`. */
export const ALERTS_PAGE_SIZE = 200;
/** Teto de ids retirados por resposta (retirada é rara; isto é só proteção). */
export const RETRACTED_LIMIT = 1000;

type DebateRow = FeedDebate & { settings: Partial<DebateSettings> | null };

/**
 * Alertas publicados de um debate (+ evidências verificadas + pessoa resolvida).
 * `since` é inclusivo em published_at — o cliente deduplica por id.
 * `retracted_ids` vem sempre completo, ignorando `since`: alertas que estiveram
 * no ar (published_at preenchido) e não estão mais (retirados no /editor ou por
 * SQL, inclusive repetições). Só ids — nada do texto vai para o público.
 * Retorna null se o debate não existe.
 */
export async function loadPublishedAlerts(
  db: SupabaseClient,
  slug: string,
  since?: string,
): Promise<AlertsPayload | null> {
  const { data: debate, error: debateErr } = await db
    .from("debates")
    .select("id, slug, title, status, settings")
    .eq("slug", slug)
    .maybeSingle<DebateRow>();
  if (debateErr) throw debateErr;
  if (!debate) return null;

  let q = db
    .from("alerts")
    .select("*")
    .eq("debate_id", debate.id)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(ALERTS_PAGE_SIZE);
  if (since) q = q.gte("published_at", since);

  const [alertsRes, speakersRes, retractedRes] = await Promise.all([
    q,
    db.from("speaker_map").select("speaker_label, person").eq("debate_id", debate.id),
    db
      .from("alerts")
      .select("id")
      .eq("debate_id", debate.id)
      .neq("status", "published")
      .not("published_at", "is", null)
      .limit(RETRACTED_LIMIT),
  ]);
  if (alertsRes.error) throw alertsRes.error;
  if (speakersRes.error) throw speakersRes.error;
  if (retractedRes.error) throw retractedRes.error;
  const alerts = (alertsRes.data ?? []) as Alert[];
  const speakers = (speakersRes.data ?? []) as { speaker_label: string; person: string }[];
  const retractedIds = ((retractedRes.data ?? []) as { id: string }[]).map((r) => r.id);

  const verificationIds = [...new Set(alerts.map((a) => a.verification_id))];
  const repeatIds = [...new Set(alerts.map((a) => a.repeat_of).filter((x): x is string => !!x))];

  const [evidenceRes, originsRes] = await Promise.all([
    verificationIds.length
      ? db
          .from("evidence")
          .select("verification_id, url, source_name, source_tier, quote, evidence_type, published_at, quote_verified")
          .in("verification_id", verificationIds)
          .eq("quote_verified", true)
      : Promise.resolve({ data: [], error: null }),
    repeatIds.length
      ? db.from("alerts").select("id, created_at").in("id", repeatIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (evidenceRes.error) throw evidenceRes.error;
  if (originsRes.error) throw originsRes.error;

  const repeatOrigins: Record<string, string> = {};
  for (const o of (originsRes.data ?? []) as { id: string; created_at: string }[]) repeatOrigins[o.id] = o.created_at;

  const settings = resolveSettings(debate.settings);
  const attribution = attributionFrom(settings, speakers);

  return {
    debate: { id: debate.id, slug: debate.slug, title: debate.title, status: debate.status },
    alerts: buildFeed({
      alerts,
      evidence: (evidenceRes.data ?? []) as Parameters<typeof buildFeed>[0]["evidence"],
      attribution,
      repeatOrigins,
      retractedIds,
    }),
    attribution,
    retracted_ids: retractedIds,
    server_time: new Date().toISOString(),
  };
}
