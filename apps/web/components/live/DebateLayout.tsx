"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { FeedState, TranscriptState } from "@/lib/live/types";
import { STORAGE_KEYS, storageGet, storageSet } from "@/lib/storage";
import { AlertFeed } from "./AlertFeed";
import { TranscriptPanel } from "./TranscriptPanel";
import { VideoPlayer } from "./VideoPlayer";

export type ViewMode = "video" | "info";

const STATUS_TEXT = { scheduled: "Agendado", live: "Ao vivo", ended: "Encerrado" } as const;

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const opt = (value: ViewMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => onChange(value)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        mode === value ? "bg-fg text-bg" : "text-muted hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Modo de exibição" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {opt("video", "Com vídeo")}
      {opt("info", "Só informações")}
    </div>
  );
}

/** Layout do /ao-vivo: compartilhado entre o debate real e a demonstração. */
export function DebateLayout({
  title,
  status,
  youtubeUrl,
  feed,
  transcript,
  transcriptOpen,
  onTranscriptToggle,
  extra,
}: {
  title: string;
  status: keyof typeof STATUS_TEXT;
  youtubeUrl: string | null;
  feed: FeedState;
  transcript: TranscriptState;
  transcriptOpen: boolean;
  onTranscriptToggle: (open: boolean) => void;
  extra?: ReactNode;
}) {
  const [mode, setMode] = useState<ViewMode>("video");

  useEffect(() => {
    const stored = storageGet(STORAGE_KEYS.viewMode);
    if (stored === "video" || stored === "info") setMode(stored);
  }, []);

  function change(m: ViewMode) {
    setMode(m);
    storageSet(STORAGE_KEYS.viewMode, m);
  }

  const transcriptPanel = <TranscriptPanel transcript={transcript} open={transcriptOpen} onToggle={onTranscriptToggle} />;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-8 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold sm:text-xl">{title}</h1>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            {status === "live" ? <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-red-fg" /> : null}
            {STATUS_TEXT[status]}
          </p>
        </div>
        <ViewModeToggle mode={mode} onChange={change} />
      </div>

      {extra ? <div className="mt-3">{extra}</div> : null}

      {mode === "video" ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          {/* No celular o vídeo fica preso no topo enquanto o feed rola */}
          <div className="sticky top-0 z-10 -mx-4 bg-bg px-4 pb-2 pt-1 lg:static lg:mx-0 lg:p-0">
            <VideoPlayer url={youtubeUrl} title={title} />
            <div className="mt-4 hidden lg:block">{transcriptPanel}</div>
          </div>
          <div className="lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto lg:pr-1">
            <AlertFeed feed={feed} />
            <div className="mt-4 lg:hidden">{transcriptPanel}</div>
          </div>
        </div>
      ) : (
        <div className="mx-auto mt-4 flex max-w-2xl flex-col gap-4">
          <AlertFeed feed={feed} />
          {transcriptPanel}
        </div>
      )}
    </div>
  );
}
