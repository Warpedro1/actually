"use client";

import { useState } from "react";
import type { Attribution } from "@/lib/feed";
import { useLiveAlerts } from "@/lib/live/useLiveAlerts";
import { useLiveSegments } from "@/lib/live/useLiveSegments";
import type { LivePreview } from "@/lib/live/types";
import { DebateLayout } from "./DebateLayout";

export interface LiveDebateProps {
  debate: {
    id: string;
    slug: string;
    title: string;
    status: "scheduled" | "live" | "ended";
    youtube_url: string | null;
  };
  attribution: Attribution;
  /** Prévia do editor (/admin/previa): sessão do editor em vez do cliente anônimo. */
  preview?: LivePreview;
}

/** /ao-vivo/[slug] com dados reais (Realtime + fallback de polling). */
export function LiveDebate({ debate, attribution, preview }: LiveDebateProps) {
  const feed = useLiveAlerts(debate.slug, debate.id, attribution, preview);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const transcript = useLiveSegments(debate.id, transcriptOpen, attribution, preview?.client);
  return (
    <DebateLayout
      title={debate.title}
      status={debate.status}
      youtubeUrl={debate.youtube_url}
      feed={feed}
      transcript={transcript}
      transcriptOpen={transcriptOpen}
      onTranscriptToggle={setTranscriptOpen}
    />
  );
}
