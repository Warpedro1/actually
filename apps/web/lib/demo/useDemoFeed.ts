"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeAlerts, resolvePerson, type FeedAlert } from "../feed";
import { addedIds, type FeedState, type TranscriptLine, type TranscriptState } from "../live/types";
import { DEMO_ATTRIBUTION, DEMO_TEMPLATES, DEMO_TRANSCRIPT, demoAlert } from "./fixtures";

/** Intervalo entre alertas simulados. */
export const DEMO_ALERT_MS = 6000;
const DEMO_LINE_MS = 2500;

/**
 * Simulador do modo demonstração: começa com dois alertas e injeta um novo a
 * cada poucos segundos (e linhas de transcrição), sem tocar no Supabase.
 */
export function useDemoFeed(): {
  feed: FeedState;
  transcript: TranscriptState;
  running: boolean;
  setRunning: (v: boolean) => void;
  injectNow: () => void;
} {
  const [alerts, setAlerts] = useState<FeedAlert[]>([]);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(new Set());
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [running, setRunning] = useState(true);
  const seq = useRef(0);
  const nextTemplate = useRef(0);
  const nextLine = useRef(0);
  const originals = useRef(new Map<number, FeedAlert>());
  const alertsRef = useRef<FeedAlert[]>([]);

  const make = useCallback((at: Date) => {
    const i = nextTemplate.current % DEMO_TEMPLATES.length;
    nextTemplate.current += 1;
    seq.current += 1;
    const a = demoAlert(i, seq.current, at, originals.current);
    if (!originals.current.has(i)) originals.current.set(i, a);
    return a;
  }, []);

  const inject = useCallback(
    (items: FeedAlert[], animate: boolean) => {
      const prev = alertsRef.current;
      const next = mergeAlerts(prev, items);
      alertsRef.current = next;
      setAlerts(next);
      if (animate) {
        const added = addedIds(prev, next);
        setFreshIds((s) => new Set([...s, ...added]));
      }
    },
    [],
  );

  // Semente: dois alertas "de alguns minutos atrás".
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return; // StrictMode roda efeitos duas vezes em dev
    seeded.current = true;
    const now = Date.now();
    inject([make(new Date(now - 4 * 60_000)), make(new Date(now - 90_000))], false);
    const seed: TranscriptLine[] = DEMO_TRANSCRIPT.slice(0, 3).map((l, i) => ({
      id: `seed-${i}`,
      speaker: resolvePerson(l.speaker, DEMO_ATTRIBUTION),
      text: l.text,
      at: new Date(now - (3 - i) * 20_000).toISOString(),
    }));
    nextLine.current = 3;
    setLines(seed.reverse());
  }, [inject, make]);

  const injectNow = useCallback(() => inject([make(new Date())], true), [inject, make]);

  useEffect(() => {
    if (!running) return;
    const a = setInterval(injectNow, DEMO_ALERT_MS);
    const t = setInterval(() => {
      const l = DEMO_TRANSCRIPT[nextLine.current % DEMO_TRANSCRIPT.length]!;
      nextLine.current += 1;
      setLines((prev) =>
        [
          {
            id: `line-${nextLine.current}`,
            speaker: resolvePerson(l.speaker, DEMO_ATTRIBUTION),
            text: l.text,
            at: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 60),
      );
    }, DEMO_LINE_MS);
    return () => {
      clearInterval(a);
      clearInterval(t);
    };
  }, [running, injectNow]);

  return {
    // `debate`/`capture` ficam nulos: o selo da demonstração se identifica pelo modo.
    feed: { alerts, mode: "demo", error: null, freshIds, loaded: true, debate: null, capture: null },
    transcript: { lines, error: null },
    running,
    setRunning,
    injectNow,
  };
}
