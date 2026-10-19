// Agregação de latência de um debate real (ensaio ou ao vivo) — funções puras.
// Os dados vêm do Supabase em latency-report.ts.
import { latencyStat, percentile, type LatencyStat } from "./metrics";
import { ms, table } from "./report";

export interface VerificationRow {
  latency_ms: Record<string, unknown> | null;
}

export interface AlertRow {
  id: string;
  status: "pending_review" | "published" | "rejected";
  verdict: "contradito" | "impreciso";
  is_repeat: boolean;
  created_at: string;
  published_at: string | null;
  reviewed_at: string | null;
  /** Fim da fala no relógio do agente (segments.captured_at), quando disponível. */
  segment_captured_at: string | null;
}

const t = (iso: string | null): number | null => (iso ? Date.parse(iso) : null);
const diff = (a: string | null, b: string | null): number | null => {
  const x = t(a), y = t(b);
  return x === null || y === null || Number.isNaN(x) || Number.isNaN(y) ? null : y - x;
};

/** p50/p95 por chave de verifications.latency_ms. */
export function stageLatency(rows: VerificationRow[]): Record<string, LatencyStat> {
  const per = new Map<string, number[]>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.latency_ms ?? {})) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (!per.has(k)) per.set(k, []);
      per.get(k)!.push(v);
    }
  }
  const out: Record<string, LatencyStat> = {};
  for (const k of [...per.keys()].sort()) out[k] = latencyStat(per.get(k)!);
  return out;
}

export interface EditorStats {
  total_alerts: number;
  by_status: Record<string, number>;
  /** Alertas que passaram pelo editor (reviewed_at preenchido). */
  reviewed: number;
  /** created_at → reviewed_at. É a latência que o HITL adiciona. */
  editor_wait: LatencyStat;
  /** Pendentes no momento da consulta, e o mais antigo (ms). */
  pending_now: number;
  oldest_pending_ms: number | null;
  /** Fim da fala → alerta criado (pipeline completo, sem HITL). */
  speech_to_created: LatencyStat;
  /** Fim da fala → publicado (inclui HITL quando ligado). */
  speech_to_published: LatencyStat;
  /** Alertas não repetidos criados por minuto (minutos com pelo menos um alerta). */
  per_minute: { minutes_with_alerts: number; mean: number | null; p95: number | null; max: number };
  /** Pico de alertas criados em qualquer janela deslizante de 60 s. */
  peak_60s: number;
}

export function editorStats(alerts: AlertRow[], now: Date = new Date()): EditorStats {
  const by_status: Record<string, number> = {};
  for (const a of alerts) by_status[a.status] = (by_status[a.status] ?? 0) + 1;
  const reviewedRows = alerts.filter((a) => a.reviewed_at);
  const waits = reviewedRows.map((a) => diff(a.created_at, a.reviewed_at)).filter((v): v is number => v !== null && v >= 0);
  const pending = alerts.filter((a) => a.status === "pending_review");
  const pendingAges = pending.map((a) => now.getTime() - Date.parse(a.created_at));
  const toCreated = alerts.map((a) => diff(a.segment_captured_at, a.created_at)).filter((v): v is number => v !== null);
  const toPublished = alerts
    .filter((a) => a.status === "published")
    .map((a) => diff(a.segment_captured_at, a.published_at))
    .filter((v): v is number => v !== null);

  const fresh = alerts.filter((a) => !a.is_repeat).map((a) => Date.parse(a.created_at)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  const buckets = new Map<number, number>();
  for (const x of fresh) {
    const m = Math.floor(x / 60_000);
    buckets.set(m, (buckets.get(m) ?? 0) + 1);
  }
  const counts = [...buckets.values()];
  let peak = 0;
  for (let i = 0, j = 0; j < fresh.length; j++) {
    while (fresh[j]! - fresh[i]! >= 60_000) i++;
    peak = Math.max(peak, j - i + 1);
  }

  return {
    total_alerts: alerts.length,
    by_status,
    reviewed: reviewedRows.length,
    editor_wait: latencyStat(waits),
    pending_now: pending.length,
    oldest_pending_ms: pendingAges.length ? Math.max(...pendingAges) : null,
    speech_to_created: latencyStat(toCreated),
    speech_to_published: latencyStat(toPublished),
    per_minute: {
      minutes_with_alerts: counts.length,
      mean: counts.length ? counts.reduce((s, c) => s + c, 0) / counts.length : null,
      p95: percentile(counts, 95),
      max: counts.length ? Math.max(...counts) : 0,
    },
    peak_60s: peak,
  };
}

export function renderLatencyReport(slug: string, stages: Record<string, LatencyStat>, nVerifications: number, ed: EditorStats): string {
  const out: string[] = [];
  out.push(`# Latência — debate \`${slug}\``);
  out.push("");
  out.push(`## Pipeline por etapa (${nVerifications} verificações)`);
  out.push("");
  out.push(
    Object.keys(stages).length
      ? table(["Etapa", "n", "p50", "p95", "máx"], Object.entries(stages).map(([k, s]) => [k, s.n, ms(s.p50), ms(s.p95), ms(s.max)]))
      : "_Sem verifications.latency_ms._",
  );
  out.push("");
  out.push(`## Alertas e editor (${ed.total_alerts} alertas: ${Object.entries(ed.by_status).map(([k, v]) => `${k}=${v}`).join(", ") || "nenhum"})`);
  out.push("");
  out.push(
    table(
      ["Medida", "n", "p50", "p95", "máx"],
      [
        ["Fim da fala → alerta criado", ed.speech_to_created.n, ms(ed.speech_to_created.p50), ms(ed.speech_to_created.p95), ms(ed.speech_to_created.max)],
        ["Espera do editor (criado → revisado)", ed.editor_wait.n, ms(ed.editor_wait.p50), ms(ed.editor_wait.p95), ms(ed.editor_wait.max)],
        ["Fim da fala → publicado", ed.speech_to_published.n, ms(ed.speech_to_published.p50), ms(ed.speech_to_published.p95), ms(ed.speech_to_published.max)],
      ],
    ),
  );
  out.push("");
  out.push(`- Pendentes agora: ${ed.pending_now}${ed.oldest_pending_ms !== null ? ` (mais antigo há ${ms(ed.oldest_pending_ms)})` : ""}`);
  out.push(
    `- Volume (alertas novos, sem repetições): média ${ed.per_minute.mean?.toFixed(2) ?? "—"}/min nos ${ed.per_minute.minutes_with_alerts} minutos com alerta; p95 ${ed.per_minute.p95?.toFixed(1) ?? "—"}/min; máx ${ed.per_minute.max}/min; pico em janela de 60 s: ${ed.peak_60s}`,
  );
  out.push("");
  out.push(`Use com \`docs/human-in-the-loop.md\` (tabela de decisão): a espera do editor é a latência que o HITL adiciona; o pico por minuto deve caber na capacidade do editor.`);
  return out.join("\n");
}
