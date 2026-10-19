"use client";

import { useState } from "react";
import type { Attribution } from "@/lib/feed";
import { useLiveAlerts } from "@/lib/live/useLiveAlerts";
import { useLiveSegments } from "@/lib/live/useLiveSegments";
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
}

/** /ao-vivo/[slug] com dados reais (Realtime + fallback de polling). */
export function LiveDebate({ debate, attribution }: LiveDebateProps) {
  const feed = useLiveAlerts(debate.slug, debate.id, attribution);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const transcript = useLiveSegments(debate.id, transcriptOpen, attribution);
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
