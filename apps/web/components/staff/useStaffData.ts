"use client";

import type { Debate } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { storageGet, storageSet } from "@/lib/storage";
import { errMsg } from "./ui";

const SELECTED_KEY = "actually:staff-debate";
const STATUS_ORDER = { live: 0, scheduled: 1, ended: 2 } as const;

/** Debates visíveis ao editor + o selecionado (lembrado entre /editor e /admin). */
export function useDebates(client: SupabaseClient) {
  const [debates, setDebates] = useState<Debate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const { data, error: err } = await client.from("debates").select("*").order("created_at", { ascending: false });
    if (err) return setError(errMsg(err));
    const list = ((data ?? []) as Debate[]).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    setDebates(list);
    setError(null);
    setSelectedId((cur) => {
      if (cur && list.some((d) => d.id === cur)) return cur;
      const stored = storageGet(SELECTED_KEY);
      if (stored && list.some((d) => d.id === stored)) return stored;
      return list[0]?.id ?? null;
    });
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    storageSet(SELECTED_KEY, id);
  }, []);

  const selected = debates.find((d) => d.id === selectedId) ?? null;
  return { debates, selected, select, reload, error };
}

/** Relógio que atualiza a cada `ms` (idades de heartbeat, tempo de espera). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Assina mudanças de uma tabela via Realtime e chama `onChange` (com debounce).
 * `filter` no formato do postgres_changes (ex.: "debate_id=eq.<uuid>").
 */
export function useTableChanges(
  client: SupabaseClient,
  table: string,
  filter: string | undefined,
  onChange: () => void,
  enabled = true,
): "connecting" | "live" | "down" {
  const [status, setStatus] = useState<"connecting" | "live" | "down">("connecting");
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    };
    const ch = client
      .channel(`staff:${table}:${filter ?? "all"}:${Math.random().toString(36).slice(2, 8)}`)
      .on("postgres_changes", { event: "*", schema: "public", table, ...(filter ? { filter } : {}) }, fire)
      .subscribe((s) => {
        if (s === "SUBSCRIBED") setStatus("live");
        else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") setStatus("down");
      });
    return () => {
      clearTimeout(timer);
      void client.removeChannel(ch);
    };
  }, [client, table, filter, onChange, enabled]);
  return status;
}
