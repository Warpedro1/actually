"use client";

import type { Segment } from "@actually/db";
import { useEffect, useRef, useState } from "react";
import { resolvePerson, type Attribution } from "../feed";
import { publicBrowserClient } from "../supabase/browser";
import type { TranscriptLine, TranscriptState } from "./types";

const MAX_LINES = 60;

function toLine(s: Pick<Segment, "id" | "speaker_label" | "text" | "received_at">, attribution: Attribution): TranscriptLine {
  return { id: String(s.id), speaker: resolvePerson(s.speaker_label, attribution), text: s.text, at: s.received_at };
}

/**
 * Transcrição ao vivo (opcional): só assina o Realtime de `segments` enquanto
 * o painel está aberto, para não gastar conexão de quem não usa.
 */
export function useLiveSegments(debateId: string, enabled: boolean, attribution: Attribution): TranscriptState {
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const attrRef = useRef(attribution);
  attrRef.current = attribution;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let client: ReturnType<typeof publicBrowserClient>;
    try {
      client = publicBrowserClient();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    const push = (rows: TranscriptLine[]) =>
      setLines((prev) => {
        const seen = new Set(prev.map((l) => l.id));
        const merged = [...rows.filter((r) => !seen.has(r.id)).reverse(), ...prev];
        merged.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        return merged.slice(0, MAX_LINES);
      });

    void client
      .from("segments")
      .select("id, speaker_label, text, received_at")
      .eq("debate_id", debateId)
      .order("received_at", { ascending: false })
      .limit(30)
      .then(({ data, error: err }) => {
        if (disposed) return;
        if (err) setError("Transcrição indisponível no momento.");
        else push((data ?? []).map((s) => toLine(s as Segment, attrRef.current)));
      });

    const ch = client
      .channel(`segments:${debateId}:${Math.random().toString(36).slice(2, 8)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "segments", filter: `debate_id=eq.${debateId}` },
        (p) => push([toLine(p.new as Segment, attrRef.current)]),
      )
      .subscribe((status) => {
        if (disposed) return;
        if (status === "SUBSCRIBED") setError(null);
        else if (status !== "CLOSED") setError("Transcrição ao vivo reconectando…");
      });

    return () => {
      disposed = true;
      void client.removeChannel(ch);
    };
  }, [debateId, enabled]);

  return { lines, error };
}
