// Formatação fixa no fuso de Brasília: o debate acontece no Brasil e o servidor
// roda em UTC — fuso fixo evita divergência entre SSR e hidratação.

const TZ = "America/Sao_Paulo";

const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const timeSecFmt = new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: TZ,
});
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: TZ,
});

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "22:14" */
export function formatTime(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? timeFmt.format(d) : "—";
}

/** "22:14:05" */
export function formatTimeSec(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? timeSecFmt.format(d) : "—";
}

/** "23/10, 21:00" */
export function formatDateTime(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? dateTimeFmt.format(d) : "—";
}

/** Segundos decorridos desde `iso` (null se inválido). */
export function secondsSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  const d = toDate(iso);
  return d ? Math.max(0, Math.round((now - d.getTime()) / 1000)) : null;
}

/** "agora", "12 s", "3 min 05 s", "2 h 10 min" */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 1) return "agora";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m} min ${String(s).padStart(2, "0")} s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h} h ${String(m).padStart(2, "0")} min`;
}

/** Converte ISO para o valor de <input type="datetime-local"> no fuso de Brasília. */
export function isoToLocalInput(iso: string | null | undefined): string {
  const d = toDate(iso);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return parts.replace(" ", "T");
}

/**
 * Converte o valor de <input type="datetime-local"> (interpretado no fuso de
 * Brasília, UTC−3 sem horário de verão desde 2019) para ISO UTC.
 */
export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) + 3, Number(mi));
  return new Date(utc).toISOString();
}
