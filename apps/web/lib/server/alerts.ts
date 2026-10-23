import { resolveSettings, type Alert, type DebateSettings } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attributionFrom, buildFeed, type AlertsPayload, type FeedCapture, type FeedDebate } from "../feed";

/** Limite por resposta — o cliente pagina via `since`. */
export const ALERTS_PAGE_SIZE = 200;
/** Teto de ids retirados por resposta (retirada é rara; isto é só proteção). */
export const RETRACTED_LIMIT = 1000;

type DebateRow = FeedDebate & { settings: Partial<DebateSettings> | null; is_test: boolean };

/**
 * Agente sem heartbeat há mais que isso não está capturando. O agente bate a
 * cada 2 s e `capture_heartbeat()` usa `failover_after_s` (padrão 10 s) para
 * decidir se promove o reserva; aqui a janela é a mesma, com piso de 10 s.
 */
const AGENT_ALIVE_S = 10;

/**
 * Estado da checagem para o selo público. As tabelas de captura são legíveis só
 * por editor (RLS), então quem calcula é o servidor, que roda com service role —
 * e devolve apenas estado e hora, nunca o `reported` inteiro: ele carrega trecho
 * de transcrição e o caminho do arquivo na máquina de quem captura.
 */
export function captureStateFrom(
  debateStatus: FeedDebate["status"],
  agentAlive: boolean,
  lastSegmentAt: string | null,
): FeedCapture["state"] {
  if (agentAlive) return "running";
  if (debateStatus === "ended") return "finished";
  // já houve fala e nada está capturando: caiu ou foi parada
  return lastSegmentAt ? "paused" : "waiting";
}

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
  opts: { includeTest?: boolean } = {},
): Promise<AlertsPayload | null> {
  const { data: debate, error: debateErr } = await db
    .from("debates")
    .select("id, slug, title, status, check_mode, public_note, settings, is_test")
    .eq("slug", slug)
    .maybeSingle<DebateRow>();
  if (debateErr) throw debateErr;
  // Service role passa por cima da RLS: debate de teste só sai na prévia do editor.
  if (!debate || (debate.is_test && !opts.includeTest)) return null;

  let q = db
    .from("alerts")
    .select("*")
    .eq("debate_id", debate.id)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(ALERTS_PAGE_SIZE);
  if (since) q = q.gte("published_at", since);

  const aliveSince = new Date(Date.now() - AGENT_ALIVE_S * 1000).toISOString();
  const [alertsRes, speakersRes, retractedRes, agentRes, segmentRes] = await Promise.all([
    q,
    db.from("speaker_map").select("speaker_label, person").eq("debate_id", debate.id),
    db
      .from("alerts")
      .select("id")
      .eq("debate_id", debate.id)
      .neq("status", "published")
      .not("published_at", "is", null)
      .limit(RETRACTED_LIMIT),
    // agente ativo com heartbeat recente = checagem acontecendo agora
    db
      .from("capture_agents")
      .select("id")
      .eq("debate_id", debate.id)
      .eq("active", true)
      .gte("last_heartbeat", aliveSince)
      .limit(1),
    // última fala recebida: usa o índice (debate_id, received_at desc). O contador
    // reportado pela máquina zera quando o daemon reinicia; segments é append-only.
    db
      .from("segments")
      .select("received_at")
      .eq("debate_id", debate.id)
      .order("received_at", { ascending: false })
      .limit(1),
  ]);
  if (alertsRes.error) throw alertsRes.error;
  if (speakersRes.error) throw speakersRes.error;
  if (retractedRes.error) throw retractedRes.error;
  if (agentRes.error) throw agentRes.error;
  if (segmentRes.error) throw segmentRes.error;
  const lastSegmentAt = ((segmentRes.data ?? []) as { received_at: string }[])[0]?.received_at ?? null;
  const capture: FeedCapture = {
    state: captureStateFrom(debate.status, (agentRes.data ?? []).length > 0, lastSegmentAt),
    last_segment_at: lastSegmentAt,
  };
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
    debate: {
      id: debate.id,
      slug: debate.slug,
      title: debate.title,
      status: debate.status,
      check_mode: debate.check_mode,
      public_note: debate.public_note,
    },
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
    capture,
  };
}
