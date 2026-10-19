import { attributionText, feedTime, repeatText, RETRACTED_TEXT, VERDICT_LABEL, type FeedAlert } from "@/lib/feed";
import { formatTime } from "@/lib/format";

const TIER_LABEL: Record<number, string> = {
  1: "fonte oficial ou checagem profissional",
  2: "imprensa de referência ou academia",
  3: "imprensa geral",
  4: "outra fonte",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * No lugar de um alerta retirado que já estava na tela: aviso neutro, sem
 * repetir a afirmação, a correção, a fonte nem quem disse.
 */
function RetractedCard({ alert }: { alert: FeedAlert }) {
  const when = feedTime(alert);
  return (
    <article
      aria-label={RETRACTED_TEXT}
      data-retracted="true"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-border bg-surface-2 px-4 py-3 text-sm text-muted"
    >
      <p className="font-medium">{RETRACTED_TEXT}</p>
      <time dateTime={when} className="text-xs tabular-nums">
        {formatTime(when)}
      </time>
    </article>
  );
}

/** Um alerta do feed público. A fonte é SEMPRE visível — nunca recolhida. */
export function AlertCard({ alert, feed, fresh = false }: { alert: FeedAlert; feed: readonly FeedAlert[]; fresh?: boolean }) {
  if (alert.retracted) return <RetractedCard alert={alert} />;
  const red = alert.verdict === "contradito";
  const label = VERDICT_LABEL[alert.verdict];
  const repeat = repeatText(alert, feed);
  const when = feedTime(alert);
  const showSummary = alert.summary.trim() && alert.summary.trim() !== alert.correction.trim();

  return (
    <article
      aria-labelledby={`alert-${alert.id}-claim`}
      className={`rounded-xl border bg-surface p-4 shadow-sm ${fresh ? "alert-enter" : ""} ${
        red ? "border-red-border" : "border-yellow-border"
      }`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
            red ? "border-red-border bg-red-bg text-red-fg" : "border-yellow-border bg-yellow-bg text-yellow-fg"
          }`}
        >
          <span aria-hidden="true">{label.icon}</span>
          {label.text}
        </span>
        <time dateTime={when} className="text-xs tabular-nums text-muted">
          {formatTime(when)}
        </time>
      </header>

      {repeat ? <p className="mt-2 text-xs font-medium text-muted">↻ {repeat}</p> : null}

      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted">{attributionText(alert)}</p>
      <p id={`alert-${alert.id}-claim`} className="mt-1 text-base leading-snug">
        “{alert.claim_text}”
      </p>

      <p className="mt-3 text-base font-semibold leading-snug">
        <span className="sr-only">Correção: </span>
        {alert.correction}
      </p>
      {showSummary ? <p className="mt-1 text-sm text-muted">{alert.summary}</p> : null}

      <div className="mt-3 space-y-2">
        {alert.evidence.map((e, i) => (
          <figure key={`${e.url}-${i}`} className="rounded-lg border border-border bg-surface-2 p-3">
            <figcaption className="text-sm">
              <span className="text-muted">Fonte: </span>
              <a href={e.url} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                {e.source_name}
              </a>{" "}
              <span className="text-xs text-muted">({hostOf(e.url)})</span>
              <span className="sr-only">, {TIER_LABEL[e.source_tier]}</span>
            </figcaption>
            <blockquote cite={e.url} className="mt-1.5 border-l-2 border-border pl-2 text-sm italic leading-snug">
              “{e.quote}”
            </blockquote>
          </figure>
        ))}
      </div>

      <footer className="mt-3 text-xs text-muted">
        Verifique a fonte. Este alerta foi gerado automaticamente e pode conter erros.
      </footer>
    </article>
  );
}
