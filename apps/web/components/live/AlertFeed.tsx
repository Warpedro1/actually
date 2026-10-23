"use client";

import { AlertCard } from "@/components/AlertCard";
import { VERDICT_LABEL, type CaptureState } from "@/lib/feed";
import type { FeedState } from "@/lib/live/types";

/**
 * Estado da **checagem**, não do debate: os dois são independentes de verdade
 * (debate encerrado com replay rodando; debate ao vivo com a captura parada).
 * O estado do debate fica no selo abaixo do título (StatusBadge).
 */
const CAPTURE_TEXT: Record<CaptureState, string> = {
  running: "Checando agora",
  waiting: "Checagem agendada",
  paused: "Checagem pausada",
  finished: "Checagem encerrada",
};

const CAPTURE_DOT: Record<CaptureState, string> = {
  running: "bg-ok-fg",
  waiting: "bg-muted",
  paused: "bg-yellow-fg",
  finished: "bg-muted",
};

export function CaptureBadge({ feed }: { feed: FeedState }) {
  // A demonstração se identifica pelo modo: não há captura nenhuma por trás.
  const demo = feed.mode === "demo";
  const state = feed.capture?.state;
  const dot = demo ? "bg-accent" : state ? CAPTURE_DOT[state] : "bg-muted";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" role="status">
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {demo ? "Demonstração — dados fictícios" : state ? CAPTURE_TEXT[state] : "Conectando…"}
    </span>
  );
}

export function AlertFeed({ feed }: { feed: FeedState }) {
  const latest = feed.alerts[0];
  const latestIsFresh = latest && feed.freshIds.has(latest.id);
  return (
    <section aria-labelledby="feed-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="feed-title" className="text-sm font-semibold uppercase tracking-wide text-muted">
          Alertas{feed.alerts.length ? ` (${feed.alerts.length})` : ""}
        </h2>
        <CaptureBadge feed={feed} />
      </div>

      {/* Anúncio curto para leitores de tela quando chega alerta novo */}
      <p className="sr-only" aria-live="polite">
        {latestIsFresh ? `Novo alerta: ${VERDICT_LABEL[latest.verdict].text}. ${latest.claim_text}` : ""}
      </p>

      {feed.error ? (
        <p role="alert" className="rounded-lg border border-yellow-border bg-yellow-bg px-3 py-2 text-sm text-yellow-fg">
          {feed.error}
        </p>
      ) : null}

      {!feed.loaded ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">Carregando alertas…</p>
      ) : feed.alerts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
          <p className="font-medium text-fg">Nenhum alerta até agora.</p>
          <p className="mt-1">
            Quando uma afirmação for contradita pelas fontes ou estiver imprecisa, ela aparece aqui, com a fonte. Na
            dúvida, o sistema fica em silêncio.
          </p>
        </div>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Alertas, do mais novo para o mais antigo">
          {feed.alerts.map((a) => (
            <li key={a.id}>
              <AlertCard alert={a} feed={feed.alerts} fresh={feed.freshIds.has(a.id)} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
