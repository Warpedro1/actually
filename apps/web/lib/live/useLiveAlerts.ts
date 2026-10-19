"use client";

import type { Alert } from "@actually/db";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyAttribution,
  latestPublishedAt,
  mergeAlerts,
  publicEvidence,
  toFeedAlert,
  type AlertsPayload,
  type Attribution,
  type FeedAlert,
} from "../feed";
import { publicBrowserClient } from "../supabase/browser";
import { addedIds, type ConnectionMode, type FeedState } from "./types";

/** Intervalo do polling quando o Realtime está fora. */
export const POLL_MS = 3000;
/** Sincronização de segurança mesmo com Realtime ok (eventos perdidos, speaker_map novo). */
const SYNC_MS = 30_000;
/** Depois de falhar, tenta recriar o canal Realtime neste intervalo. */
const RESUBSCRIBE_MS = 15_000;
/** Espalha as buscas de evidência quando milhares de clientes recebem o mesmo evento. */
const MAX_JITTER_MS = 800;

/** Cursor arredondado ao segundo: clientes no mesmo ponto compartilham o cache da CDN. */
function cursorFrom(alerts: readonly FeedAlert[]): string | undefined {
  const latest = latestPublishedAt(alerts);
  if (!latest) return undefined;
  const ms = Math.floor(Date.parse(latest) / 1000) * 1000;
  return new Date(ms).toISOString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Feed ao vivo: Realtime (postgres_changes em `alerts`) com fallback
 * automático para polling em /api/alerts a cada 3 s. Volta ao Realtime quando
 * o canal reconecta. Deduplica por id.
 *
 * Retirada: o anon não recebe o UPDATE para 'rejected' (RLS), então o aviso
 * chega por `alert_retractions` (Realtime, só ids) e por `retracted_ids` em
 * toda resposta da API (polling e sincronização de 30 s). O card na tela vira
 * "Alerta retirado após revisão"; alerta retirado que não estava na tela nunca
 * aparece.
 */
export function useLiveAlerts(slug: string, debateId: string, initialAttribution: Attribution): FeedState {
  const [alerts, setAlerts] = useState<FeedAlert[]>([]);
  const [mode, setMode] = useState<ConnectionMode>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

  const alertsRef = useRef<FeedAlert[]>([]);
  const attributionRef = useRef<Attribution>(initialAttribution);
  const loadedRef = useRef(false);
  /** Tudo que já soubemos que foi retirado (Realtime ou API) — nunca volta. */
  const retractedRef = useRef<Set<string>>(new Set());

  const commit = useCallback((incoming: FeedAlert[], attribution?: Attribution, retractedIds: readonly string[] = []) => {
    if (attribution) attributionRef.current = attribution;
    for (const id of retractedIds) retractedRef.current.add(id);
    const prev = alertsRef.current;
    let next = mergeAlerts(prev, incoming, retractedRef.current);
    if (attribution) next = applyAttribution(next, attribution);
    alertsRef.current = next;
    setAlerts(next);
    // Aviso de retirada não é "alerta novo" (nem anima, nem é anunciado).
    const gone = next.filter((a) => a.retracted).map((a) => a.id);
    if (gone.length) {
      setFreshIds((s) => (gone.some((id) => s.has(id)) ? new Set([...s].filter((id) => !gone.includes(id))) : s));
    }
    if (loadedRef.current) {
      const added = addedIds(prev, next).filter((id) => !gone.includes(id));
      if (added.length) setFreshIds((s) => new Set([...s, ...added]));
    }
  }, []);

  /** Busca na API (cacheada pela CDN). Retorna false se falhou. */
  const sync = useCallback(async (): Promise<boolean> => {
    const params = new URLSearchParams({ debate: slug });
    const since = cursorFrom(alertsRef.current);
    if (since) params.set("since", since);
    try {
      const res = await fetch(`/api/alerts?${params.toString()}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const payload = (await res.json()) as AlertsPayload;
      commit(payload.alerts, payload.attribution, payload.retracted_ids ?? []);
      setError(null);
      return true;
    } catch (err) {
      setError(`Não foi possível atualizar os alertas (${err instanceof Error ? err.message : String(err)}). Tentando de novo…`);
      return false;
    } finally {
      if (!loadedRef.current) {
        loadedRef.current = true;
        setLoaded(true);
      }
    }
  }, [slug, commit]);

  // Carga inicial
  useEffect(() => {
    void sync();
  }, [sync]);

  // Realtime com reconexão
  useEffect(() => {
    let client: SupabaseClient;
    try {
      client = publicBrowserClient();
    } catch (err) {
      setMode("polling");
      console.error("[feed] Realtime indisponível:", err);
      return;
    }
    let disposed = false;
    let channel: RealtimeChannel | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const onRow = async (row: Alert) => {
      if (row.status !== "published") {
        // Normalmente a RLS nem entrega isso ao anon; se entregar e o alerta
        // estiver na tela, ele saiu do ar: é retirada.
        if (alertsRef.current.some((a) => a.id === row.id)) commit([], undefined, [row.id]);
        return;
      }
      if (retractedRef.current.has(row.id) || (row.repeat_of && retractedRef.current.has(row.repeat_of))) return;
      await sleep(Math.random() * MAX_JITTER_MS);
      if (disposed) return;
      const { data, error: evErr } = await client
        .from("evidence")
        .select("url, source_name, source_tier, quote, evidence_type, published_at, quote_verified")
        .eq("verification_id", row.verification_id)
        .eq("quote_verified", true);
      if (evErr || !data?.length) {
        // Sem evidência legível agora: a API resolve (e nunca mostramos alerta sem fonte).
        void sync();
        return;
      }
      let repeatAt: string | null = null;
      if (row.is_repeat && row.repeat_of) {
        const orig = alertsRef.current.find((a) => a.id === row.repeat_of);
        if (orig) repeatAt = orig.created_at;
        else {
          const { data: o } = await client.from("alerts").select("created_at").eq("id", row.repeat_of).maybeSingle();
          repeatAt = (o as { created_at: string } | null)?.created_at ?? null;
        }
      }
      const fa = toFeedAlert(row, publicEvidence(data as Parameters<typeof publicEvidence>[0]), attributionRef.current, repeatAt);
      if (fa.evidence.length) commit([fa]);
    };

    const onRetraction = (row: { alert_id?: string } | null) => {
      if (row?.alert_id) commit([], undefined, [row.alert_id]);
    };

    const subscribe = () => {
      const ch = client.channel(`alerts:${debateId}:${Math.random().toString(36).slice(2, 8)}`);
      channel = ch;
      const filter = `debate_id=eq.${debateId}`;
      ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "alerts", filter }, (p) => {
        void onRow(p.new as Alert);
      })
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "alerts", filter }, (p) => {
          void onRow(p.new as Alert);
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "alert_retractions", filter }, (p) => {
          onRetraction(p.new as { alert_id?: string });
        })
        .subscribe((status) => {
          if (disposed || ch !== channel) return;
          if (status === "SUBSCRIBED") {
            clearTimeout(retry);
            setMode("realtime");
            void sync(); // cobre o que passou durante a reconexão
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setMode("polling");
            clearTimeout(retry);
            retry = setTimeout(() => {
              if (disposed) return;
              const old = channel;
              channel = null;
              if (old) void client.removeChannel(old);
              subscribe();
            }, RESUBSCRIBE_MS);
          }
        });
    };

    subscribe();
    // Canal travado sem responder: não espera o timeout da lib para começar o polling.
    const connectGuard = setTimeout(() => setMode((m) => (m === "connecting" ? "polling" : m)), 8000);
    return () => {
      disposed = true;
      clearTimeout(connectGuard);
      clearTimeout(retry);
      const old = channel;
      channel = null;
      if (old) void client.removeChannel(old);
    };
  }, [debateId, sync, commit]);

  // Polling (fallback) e sincronização periódica
  useEffect(() => {
    const ms = mode === "realtime" ? SYNC_MS : POLL_MS;
    if (mode === "connecting") return;
    const id = setInterval(() => void sync(), ms);
    return () => clearInterval(id);
  }, [mode, sync]);

  // Aba voltou ao primeiro plano: atualiza na hora
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sync]);

  return { alerts, mode, error, freshIds, loaded };
}
