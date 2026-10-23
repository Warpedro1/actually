"use client";

import type { CheckMode } from "@actually/db";
import { useEffect, useState, type ReactNode } from "react";
import { CHECK_MODE_NOTE, CHECK_MODE_TEXT, StatusBadge, type DebateStatus } from "@/components/StatusBadge";
import type { FeedState, TranscriptState } from "@/lib/live/types";
import { STORAGE_KEYS, storageGet, storageSet } from "@/lib/storage";
import { AlertFeed } from "./AlertFeed";
import { TranscriptPanel } from "./TranscriptPanel";
import { VideoPlayer } from "./VideoPlayer";

export type ViewMode = "video" | "info";

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
  checkMode,
  note,
  youtubeUrl,
  feed,
  transcript,
  transcriptOpen,
  onTranscriptToggle,
  extra,
}: {
  title: string;
  status: DebateStatus;
  /** Procedência da checagem; null = não informado (nada aparece). */
  checkMode: CheckMode | null;
  /** Observação do editor exibida acima do feed (`debates.public_note`). */
  note?: string | null;
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

  // A casca da página é cacheada (ISR): o status assado no HTML envelhece. O
  // feed devolve o valor corrente a cada 3 s — quando ele chega, vale ele,
  // inclusive quando o editor limpou a procedência ou o aviso (null é resposta).
  const live = feed.debate;
  const shownStatus = live?.status ?? status;
  const shownCheckMode = live ? live.check_mode : checkMode;
  const shownNote = live ? live.public_note : (note ?? null);
  const checkNote = shownCheckMode ? CHECK_MODE_NOTE[shownCheckMode] : null;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-8 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold sm:text-xl">{title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <StatusBadge status={shownStatus} />
            {shownCheckMode ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{CHECK_MODE_TEXT[shownCheckMode]}</span>
              </>
            ) : null}
          </p>
        </div>
        <ViewModeToggle mode={mode} onChange={change} />
      </div>

      {checkNote ? <p className="mt-2 max-w-2xl text-xs text-muted">{checkNote}</p> : null}

      {shownNote ? (
        <div
          role="note"
          aria-labelledby="debate-note-title"
          className="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg"
        >
          <p id="debate-note-title" className="text-xs font-semibold uppercase tracking-wide text-muted">
            Aviso
          </p>
          <p className="mt-0.5">{shownNote}</p>
        </div>
      ) : null}

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
