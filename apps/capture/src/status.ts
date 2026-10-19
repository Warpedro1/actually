// Linha de status no terminal. Em TTY reescreve uma linha fixa no rodapé; fora
// de TTY (serviço, redirecionamento) imprime o status a cada 15 s.

export interface StatusSnapshot {
  mode: "ATIVO" | "STANDBY" | "DRY-RUN" | "SEM API" | "REGISTRANDO";
  segments: number;
  queue: number;
  lastLatencyMs: number | null;
  dgOpen: boolean;
  dgReconnects: number;
  sourceRestarts: number;
  levelDb: number | null;
  lastText: string | null;
  clock: number;
}

export function formatStatus(s: StatusSnapshot): string {
  const lvl = s.levelDb === null ? "—" : `${s.levelDb.toFixed(0)} dB${s.levelDb < -60 ? " (silêncio?)" : ""}`;
  const lat = s.lastLatencyMs === null ? "—" : `${(s.lastLatencyMs / 1000).toFixed(1)} s`;
  const parts = [
    `[${s.mode}]`,
    formatClock(s.clock),
    `seg ${s.segments}`,
    `fila ${s.queue}`,
    `lat ${lat}`,
    `stt ${s.dgOpen ? "ok" : "OFF"}${s.dgReconnects ? ` (${s.dgReconnects} recon.)` : ""}`,
    `fonte ${s.sourceRestarts ? `${s.sourceRestarts} reinício(s)` : "ok"}`,
    `áudio ${lvl}`,
  ];
  if (s.lastText) parts.push(`“${s.lastText}”`);
  return parts.join(" | ");
}

export function formatClock(t: number): string {
  const s = Math.floor(t);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export class StatusLine {
  private last = "";
  private lastPlainPrint = 0;
  private readonly tty: boolean;

  constructor(
    private readonly out: NodeJS.WriteStream = process.stdout,
    private readonly enabled = true,
  ) {
    this.tty = Boolean(out.isTTY);
  }

  /** Mensagem permanente (fica acima da linha de status). */
  print(line: string): void {
    if (this.tty && this.enabled && this.last) this.out.write("\r\x1b[2K");
    this.out.write(`${line}\n`);
    if (this.tty && this.enabled && this.last) this.out.write(this.last);
  }

  update(text: string): void {
    if (!this.enabled) return;
    if (this.tty) {
      const cols = this.out.columns ?? 120;
      this.last = text.length > cols - 1 ? `${text.slice(0, cols - 2)}…` : text;
      this.out.write(`\r\x1b[2K${this.last}`);
    } else if (Date.now() - this.lastPlainPrint > 15_000) {
      this.lastPlainPrint = Date.now();
      this.out.write(`${text}\n`);
    }
  }

  clear(): void {
    if (this.tty && this.enabled && this.last) this.out.write("\r\x1b[2K");
    this.last = "";
  }
}
