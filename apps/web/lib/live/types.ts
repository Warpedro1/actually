import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedAlert, FeedCapture, FeedDebate } from "../feed";

/**
 * Prévia do editor (/admin/previa): o feed usa a sessão do editor em vez do
 * cliente anônimo — a RLS esconde debate de teste do público — e pede
 * `/api/alerts?preview=1` com o token (resposta sem cache de CDN).
 */
export interface LivePreview {
  client: SupabaseClient;
  token: () => Promise<string | null>;
}

/** Como o feed está recebendo alertas agora. */
export type ConnectionMode = "connecting" | "realtime" | "polling" | "demo";

export interface FeedState {
  alerts: FeedAlert[];
  mode: ConnectionMode;
  error: string | null;
  /** Alertas que chegaram depois da carga inicial (animados na entrada). */
  freshIds: ReadonlySet<string>;
  loaded: boolean;
  /**
   * Debate conforme a última resposta de /api/alerts — a casca da página é
   * cacheada (ISR), então o status assado no HTML envelhece; este é o valor
   * corrente, que chega em até 3 s. Null até a primeira resposta.
   */
  debate: FeedDebate | null;
  /** Estado da checagem agora (calculado no servidor). Null até a 1ª resposta. */
  capture: FeedCapture | null;
}

export interface TranscriptLine {
  id: string;
  speaker: string | null;
  text: string;
  at: string;
}

export interface TranscriptState {
  lines: TranscriptLine[];
  error: string | null;
}

/** IDs que estão em `next` mas não em `prev`. */
export function addedIds(prev: readonly FeedAlert[], next: readonly FeedAlert[]): string[] {
  const seen = new Set(prev.map((a) => a.id));
  return next.filter((a) => !seen.has(a.id)).map((a) => a.id);
}
