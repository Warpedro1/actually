// Log local JSONL: auditoria e reprocessamento. Tudo que foi transcrito
// (finais do Deepgram com palavras), cada segmento e cada resposta da API.

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";

export function logFileName(debate: string, name: string, date: Date = new Date()): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  const ts = date.toISOString().replace(/[:]/g, "-").replace(/\.\d+Z$/, "Z");
  return `${safe(debate)}-${safe(name)}-${ts}.jsonl`;
}

export class JsonlLogger {
  private readonly stream: WriteStream;
  readonly path: string;

  constructor(dir: string, fileName: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, fileName);
    this.stream = createWriteStream(this.path, { flags: "a" });
    this.stream.on("error", (err) => process.stderr.write(`log JSONL: ${err.message}\n`));
  }

  write(type: string, data: Record<string, unknown> = {}): void {
    this.stream.write(`${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(() => resolve()));
  }
}

/** Últimas N linhas legíveis (vão no log_tail do daemon). */
export class LineTail {
  private lines: string[] = [];
  constructor(
    private readonly max = 20,
    private readonly maxLen = 500,
  ) {}

  push(line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${line}`.slice(0, this.maxLen);
    this.lines.push(stamped);
    if (this.lines.length > this.max) this.lines.shift();
  }

  get(): string[] {
    return [...this.lines];
  }
}

/**
 * Mapa tempo-da-captura → relógio de parede, para o captured_at ser o momento
 * em que o áudio do fim da fala chegou (e não quando o Deepgram respondeu).
 */
export class WallClockMap {
  private points: { t: number; wall: number }[] = [];
  constructor(private readonly maxPoints = 6000) {}

  record(t: number, wall: number): void {
    this.points.push({ t, wall });
    if (this.points.length > this.maxPoints) this.points.splice(0, this.points.length - this.maxPoints);
  }

  /** Busca binária pelo último ponto com t ≤ alvo; interpola dentro do pedaço. */
  wallAt(t: number, fallback: number = Date.now()): number {
    const p = this.points;
    if (p.length === 0 || t < p[0]!.t) return fallback;
    let lo = 0;
    let hi = p.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p[mid]!.t <= t) lo = mid;
      else hi = mid - 1;
    }
    const pt = p[lo]!;
    return Math.round(pt.wall + (t - pt.t) * 1000);
  }
}
