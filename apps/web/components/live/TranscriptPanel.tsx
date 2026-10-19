"use client";

import { formatTimeSec } from "@/lib/format";
import type { TranscriptState } from "@/lib/live/types";

/** Transcrição ao vivo, recolhível (fechada por padrão). */
export function TranscriptPanel({
  transcript,
  open,
  onToggle,
}: {
  transcript: TranscriptState;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  return (
    <details
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
      className="rounded-xl border border-border bg-surface"
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
        Transcrição ao vivo <span className="font-normal text-muted">(automática, pode conter erros)</span>
      </summary>
      <div className="max-h-80 overflow-y-auto border-t border-border px-4 py-3">
        {transcript.error ? <p className="mb-2 text-xs text-yellow-fg">{transcript.error}</p> : null}
        {transcript.lines.length === 0 ? (
          <p className="text-sm text-muted">Aguardando falas…</p>
        ) : (
          <ol className="flex flex-col gap-2 text-sm">
            {transcript.lines.map((l) => (
              <li key={l.id} className="leading-snug">
                <time dateTime={l.at} className="mr-2 text-xs tabular-nums text-muted">
                  {formatTimeSec(l.at)}
                </time>
                {l.speaker ? <span className="mr-1 font-medium">{l.speaker}:</span> : null}
                {l.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
