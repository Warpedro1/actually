import type { ReplayPass } from "@actually/db";
import { formatDateTime, formatDuration, formatTime } from "@/lib/format";

/**
 * Passada marcada de saída no reprocessamento: a com mais trechos. Rodar o mesmo
 * arquivo de novo cria outra passada que repete o começo (debate da Globo: 474, 19 e
 * 135 trechos); marcar todas processaria esse começo duas ou três vezes.
 */
export function defaultPassIds(passes: readonly ReplayPass[]): string[] {
  const best = [...passes].sort((a, b) => b.segments - a.segments || Date.parse(a.first_at) - Date.parse(b.first_at))[0];
  return best ? [best.agent_id] : [];
}

/** "casa — 474 trechos, 50 min 24 s de gravação, 24/10, 11:21 → 12:12" */
export function passLabel(p: ReplayPass): string {
  return `${p.name} — ${p.segments} trechos, ${formatDuration(p.duration_s)} de gravação, ${formatDateTime(p.first_at)} → ${formatTime(p.last_at)}`;
}
