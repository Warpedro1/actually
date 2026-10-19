"use client";

import { useState } from "react";
import { DEMO_DEBATE } from "@/lib/demo/fixtures";
import { useDemoFeed } from "@/lib/demo/useDemoFeed";
import { DebateLayout } from "./DebateLayout";

/** /ao-vivo/demo: mesmo layout do debate real, alimentado pelo simulador local. */
export function DemoDebate() {
  const { feed, transcript, running, setRunning, injectNow } = useDemoFeed();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  return (
    <DebateLayout
      title={DEMO_DEBATE.title}
      status={DEMO_DEBATE.status}
      youtubeUrl={null}
      feed={feed}
      transcript={transcript}
      transcriptOpen={transcriptOpen}
      onTranscriptToggle={setTranscriptOpen}
      extra={
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-xs text-muted">
          <span className="font-semibold uppercase tracking-wide text-fg">Demonstração</span>
          <span>Participantes, falas e fontes fictícios — nada aqui se refere a pessoas reais.</span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setRunning(!running)}
              className="rounded-md border border-border px-2 py-1 font-medium text-fg"
            >
              {running ? "Pausar simulação" : "Retomar simulação"}
            </button>
            <button type="button" onClick={injectNow} className="rounded-md border border-border px-2 py-1 font-medium text-fg">
              Novo alerta
            </button>
          </span>
        </div>
      }
    />
  );
}
