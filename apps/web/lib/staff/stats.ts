// Estatísticas do /admin: latência por etapa e contagem de alertas por pessoa.

import type { AlertStatus, AlertVerdict } from "@actually/db";

/** Percentil por interpolação linear (p em 0..1). */
export function percentile(values: readonly number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo]! + (v[hi]! - v[lo]!) * (idx - lo);
}

export interface StageStats {
  stage: string;
  n: number;
  p50: number | null;
  p95: number | null;
}

/** Ordem do pipeline; etapas desconhecidas vão no fim (alfabético), "total" por último. */
const STAGE_ORDER = ["filter", "extract", "dedup", "embed", "retrieve", "factchecks", "indicators", "documents", "web", "verify", "quote_check", "score", "publish"];

export function latencyStats(rows: readonly { latency_ms: Record<string, number> | null }[]): StageStats[] {
  const byStage = new Map<string, number[]>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.latency_ms ?? {})) {
      if (typeof v !== "number") continue;
      const list = byStage.get(k) ?? [];
      list.push(v);
      byStage.set(k, list);
    }
  }
  const rank = (s: string) => (s === "total" ? 1e9 : STAGE_ORDER.indexOf(s) === -1 ? 1e6 : STAGE_ORDER.indexOf(s));
  return [...byStage.entries()]
    .map(([stage, vals]) => ({ stage, n: vals.length, p50: percentile(vals, 0.5), p95: percentile(vals, 0.95) }))
    .sort((a, b) => rank(a.stage) - rank(b.stage) || a.stage.localeCompare(b.stage));
}

export interface PersonCount {
  who: string;
  published_red: number;
  published_yellow: number;
  pending: number;
  rejected: number;
}

/** Neutralidade: alertas por pessoa (ou speaker não mapeado). */
export function countByPerson(
  alerts: readonly { speaker_label: string | null; status: AlertStatus; verdict: AlertVerdict }[],
  speakers: Record<string, string>,
): PersonCount[] {
  const out = new Map<string, PersonCount>();
  for (const a of alerts) {
    const who = a.speaker_label
      ? (speakers[a.speaker_label] ?? `Não mapeado (${a.speaker_label})`)
      : "Sem speaker";
    const c = out.get(who) ?? { who, published_red: 0, published_yellow: 0, pending: 0, rejected: 0 };
    if (a.status === "published") {
      if (a.verdict === "contradito") c.published_red += 1;
      else c.published_yellow += 1;
    } else if (a.status === "pending_review") c.pending += 1;
    else c.rejected += 1;
    out.set(who, c);
  }
  return [...out.values()].sort((a, b) => a.who.localeCompare(b.who, "pt-BR"));
}
