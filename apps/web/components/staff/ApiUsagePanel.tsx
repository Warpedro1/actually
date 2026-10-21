"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { formatDuration, formatTimeSec, secondsSince } from "@/lib/format";
import { staffFetch } from "@/lib/staff/fetch";
import {
  STATUS_PILL,
  WINDOW_LABEL,
  countedParts,
  ratelimitEntries,
  usageFraction,
  type UsageCard,
  type UsageCardId,
  type UsageLine,
  type UsageReport,
} from "@/lib/staff/usage";
import { Button, Card, ErrorText, Pill, errMsg } from "./ui";
import { useNow } from "./useStaffData";

/** Provedores que o pipeline/carga da base contam (os outros só têm dado oficial). */
const COUNTED: ReadonlySet<UsageCardId> = new Set(["anthropic", "voyage", "tavily", "google_factcheck", "apify"]);
const REFRESH_MS = 60_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Painel "Uso das APIs" ligado ao servidor (GET /api/ops/usage, a cada 60 s). */
export function ApiUsagePanel({ client }: { client: SupabaseClient }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(5000);

  const load = useCallback(
    async (fresh = false) => {
      setBusy(true);
      try {
        setReport(await staffFetch<UsageReport>(client, `/api/ops/usage${fresh ? "?fresh=1" : ""}`));
        setError(null);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return <ApiUsagePanelView report={report} error={error} busy={busy} now={now} onRefresh={() => void load(true)} />;
}

export function ApiUsagePanelView({
  report,
  error,
  busy,
  now,
  onRefresh,
}: {
  report: UsageReport | null;
  error: string | null;
  busy: boolean;
  now: number;
  onRefresh: () => void;
}) {
  return (
    <Card
      id="uso"
      title="Uso das APIs"
      actions={
        <span className="flex items-center gap-2">
          {report ? <span className="text-xs text-muted">consultado às {formatTimeSec(report.generated_at)}</span> : null}
          <Button onClick={onRefresh} disabled={busy}>
            {busy ? "Consultando…" : "Atualizar"}
          </Button>
        </span>
      }
    >
      <p className="mb-3 text-xs leading-snug text-muted">
        <strong className="text-fg">Oficial</strong>: o que o provedor informa pela API (saldo, uso do ciclo, custo).{" "}
        <strong className="text-fg">Contado pelo actually</strong>: o que o pipeline e a carga da base registraram; o custo é
        estimado pela tabela de preços. Atualiza sozinho a cada minuto.
      </p>
      <ErrorText>{error}</ErrorText>
      {report?.counted_error ? <ErrorText>Contagem própria indisponível: {report.counted_error}</ErrorText> : null}
      {!report ? (
        error ? null : <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {report.cards.map((c) => (
            <li key={c.id} className="min-w-0">
              <UsageCardView card={c} now={now} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function UsageCardView({ card, now }: { card: UsageCard; now: number }) {
  const pill = STATUS_PILL[card.status];
  const headingId = `uso-${card.id}`;
  return (
    <article aria-labelledby={headingId} className="flex h-full flex-col gap-3 rounded-lg border border-border bg-bg p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {card.name}
        </h3>
        <Pill tone={pill.tone}>{pill.text}</Pill>
      </header>

      {card.official.length ? (
        <Section label="Oficial">
          <ul className="flex flex-col gap-2">
            {card.official.map((l) => (
              <li key={l.label}>
                <OfficialLine line={l} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {COUNTED.has(card.id) ? (
        <Section label="Contado pelo actually">
          {card.counted.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {card.counted.map((w) => (
                <div key={w.janela} className="contents">
                  <dt className="text-muted">{WINDOW_LABEL[w.janela]}</dt>
                  <dd className="min-w-0 tabular-nums">
                    {countedParts(card.id, w).map((part, i, all) => (
                      <Fragment key={part}>
                        <span className="whitespace-nowrap">
                          {part}
                          {i < all.length - 1 ? " ·" : ""}
                        </span>{" "}
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted">Nada contado ainda.</p>
          )}
        </Section>
      ) : null}

      {card.ratelimit ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-fg">
            Limites por minuto (há {formatDuration(secondsSince(card.ratelimit.observed_at, now))})
          </summary>
          <dl className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[auto_1fr]">
            {ratelimitEntries(card.ratelimit.headers).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="break-all text-muted">{k}</dt>
                <dd className="mb-1 break-all tabular-nums sm:mb-0">{ISO.test(v) ? formatTimeSec(v) : v}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      {card.message ? <p className="text-xs leading-snug text-muted">{card.message}</p> : null}
      <a href={card.link} target="_blank" rel="noreferrer" className="mt-auto text-xs text-muted underline hover:text-fg">
        Abrir o painel do provedor ↗
      </a>
    </article>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}

const BAR = { ok: "bg-ok-fg", warn: "bg-yellow-fg", bad: "bg-red-fg" } as const;

function OfficialLine({ line }: { line: UsageLine }) {
  const f = usageFraction(line);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap justify-between gap-x-3">
        <span className="text-muted">{line.label}</span>
        <span className="tabular-nums">{line.text}</span>
      </div>
      {f ? (
        <div
          role="progressbar"
          aria-label={line.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(f.frac * 100)}
          aria-valuetext={`${Math.round(f.frac * 100)}% usado — ${line.text}`}
          className="h-2 overflow-hidden rounded-full bg-surface-2"
        >
          <div className={`h-full ${BAR[f.tone]}`} style={{ width: `${Math.max(f.frac * 100, f.frac > 0 ? 2 : 0)}%` }} />
        </div>
      ) : null}
    </div>
  );
}
