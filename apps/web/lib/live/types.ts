import type { FeedAlert } from "../feed";

/** Como o feed está recebendo alertas agora. */
export type ConnectionMode = "connecting" | "realtime" | "polling" | "demo";

export interface FeedState {
  alerts: FeedAlert[];
  mode: ConnectionMode;
  error: string | null;
  /** Alertas que chegaram depois da carga inicial (animados na entrada). */
  freshIds: ReadonlySet<string>;
  loaded: boolean;
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
