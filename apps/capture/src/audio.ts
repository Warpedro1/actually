// Fonte de áudio: ffmpeg (e yt-dlp, para o YouTube) → PCM s16le 16 kHz mono.
//
// A montagem de argumentos é pura (testada por SO/fonte). A classe AudioSource
// cuida dos processos: reinicia com backoff quando uma fonte ao vivo cai e
// mantém a linha do tempo contínua (t só cresce), preenchendo o buraco com
// silêncio para t continuar alinhado ao relógio de parede.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Backoff } from "./backoff";

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2; // s16le mono
/** Pedaços de 100 ms: dentro da faixa recomendada pelo Deepgram (20–250 ms). */
export const CHUNK_BYTES = BYTES_PER_SECOND / 10;

export type SourceSpec =
  | { kind: "youtube"; url: string; format: string }
  | { kind: "device"; device: string }
  | { kind: "file"; path: string; realtime: boolean };

export type Platform = NodeJS.Platform;

export const DEFAULT_YTDLP_FORMAT = "bestaudio/best";

export function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.FFMPEG_PATH || "ffmpeg";
}

export function ytDlpBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.YTDLP_PATH || "yt-dlp";
}

/**
 * Entrada de dispositivo por SO.
 * - macOS: avfoundation, só áudio → ":<índice>" (aceita "2" e completa ":2").
 * - Linux: pulse (PipeWire também expõe pulse). Para loopback use o monitor do
 *   sink, ex. "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor". Prefixo
 *   "alsa:" usa ALSA direto (ex. "alsa:hw:1,0").
 * - Windows: dshow → "audio=<nome>" (aceita só o nome e completa).
 */
export function deviceInputArgs(device: string, platform: Platform): string[] {
  const d = device.trim();
  switch (platform) {
    case "darwin":
      return ["-f", "avfoundation", "-i", d.includes(":") ? d : `:${d}`];
    case "win32":
      return ["-f", "dshow", "-i", d.startsWith("audio=") ? d : `audio=${d}`];
    default:
      if (d.startsWith("alsa:")) return ["-f", "alsa", "-i", d.slice("alsa:".length)];
      return ["-f", "pulse", "-i", d || "default"];
  }
}

const OUTPUT_ARGS = ["-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1"];

/** Argumentos completos do ffmpeg para a fonte. */
export function buildFfmpegArgs(spec: SourceSpec, platform: Platform): string[] {
  const base = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  switch (spec.kind) {
    case "youtube":
      // entrada vem do stdout do yt-dlp
      return [...base, "-i", "pipe:0", ...OUTPUT_ARGS];
    case "file":
      return [...base, ...(spec.realtime ? ["-re"] : []), "-i", spec.path, ...OUTPUT_ARGS];
    case "device":
      return [...base, ...deviceInputArgs(spec.device, platform), ...OUTPUT_ARGS];
  }
}

export function buildYtDlpArgs(url: string, format: string = DEFAULT_YTDLP_FORMAT): string[] {
  return ["-f", format, "--no-part", "--no-playlist", "--quiet", "--no-warnings", "-o", "-", url];
}

/** Gravação curta para o `doctor --device` medir o nível. */
export function buildProbeArgs(device: string, platform: Platform, seconds: number): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...deviceInputArgs(device, platform),
    "-t",
    String(seconds),
    ...OUTPUT_ARGS,
  ];
}

/** Comandos que listam dispositivos de áudio (a saída vem no stderr do ffmpeg). */
export function listDevicesCommands(platform: Platform, ffmpeg = "ffmpeg"): { cmd: string; args: string[] }[] {
  switch (platform) {
    case "darwin":
      return [{ cmd: ffmpeg, args: ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""] }];
    case "win32":
      return [{ cmd: ffmpeg, args: ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"] }];
    default:
      return [
        { cmd: ffmpeg, args: ["-hide_banner", "-sources", "pulse"] },
        { cmd: "pactl", args: ["list", "short", "sources"] },
      ];
  }
}

/** Nível RMS em dBFS de PCM s16le; -90 para silêncio absoluto. */
export function levelDbfs(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return -90;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / n);
  return rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
}

/** Pico em dBFS. */
export function peakDbfs(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  return peak > 0 ? Math.max(-90, 20 * Math.log10(peak / 32768)) : -90;
}

export interface AudioSourceEvents {
  /** Pedaço de PCM e o tempo (s, linha da captura) do seu primeiro sample. */
  chunk: [buf: Buffer, t: number];
  restart: [info: { attempt: number; delayMs: number; reason: string }];
  /** Fim natural (arquivo terminou) ou após stop(). */
  end: [];
  /** Erro fatal (arquivo inválido); fontes ao vivo nunca emitem, só reiniciam. */
  fatal: [err: Error];
  log: [line: string];
}

export interface AudioSourceOptions {
  spec: SourceSpec;
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  /** Máximo de silêncio inserido num reinício (s). */
  maxGapFillS?: number;
}

export class AudioSource extends EventEmitter<AudioSourceEvents> {
  private procs: ChildProcess[] = [];
  private generation = 0;
  private stopping = false;
  private paused = false;
  private bytes = 0; // total já emitido (define t)
  private carry = Buffer.alloc(0);
  private lastDataWall = 0;
  private startedAt = 0;
  private readonly backoff = new Backoff({ baseMs: 1000, maxMs: 15_000, jitter: 0.2 });
  private restartTimer: NodeJS.Timeout | null = null;
  private levelAcc = { sum: 0, n: 0 };
  private _levelDb: number | null = null;
  private readonly stderrTail: string[] = [];
  restarts = 0;

  constructor(private readonly opts: AudioSourceOptions) {
    super();
  }

  get live(): boolean {
    return this.opts.spec.kind !== "file";
  }

  /** Segundos de áudio já produzidos (relógio da captura). */
  get clock(): number {
    return this.bytes / BYTES_PER_SECOND;
  }

  /** dBFS médio do último ~1 s. */
  get levelDb(): number | null {
    return this._levelDb;
  }

  start(): void {
    this.spawnPipeline();
  }

  /** Só faz sentido para arquivo (não dá para pausar uma live). */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.procs.at(-1)?.stdout?.pause(); // o último é sempre o ffmpeg
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.procs.at(-1)?.stdout?.resume();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const procs = this.procs;
    const closed = procs.map(
      (p) => new Promise<void>((r) => (p.exitCode !== null || p.signalCode !== null ? r() : p.once("close", () => r()))),
    );
    for (const p of procs) p.kill();
    await Promise.race([Promise.all(closed), new Promise((r) => setTimeout(r, 3000))]);
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    if (procs.length === 0) this.emit("end");
  }

  private spawnPipeline(): void {
    const { spec } = this.opts;
    const platform = this.opts.platform ?? process.platform;
    const env = this.opts.env ?? process.env;
    const gen = ++this.generation;
    this.startedAt = Date.now();
    this.carry = Buffer.alloc(0);

    const ffArgs = buildFfmpegArgs(spec, platform);
    let yt: ChildProcess | null = null;
    if (spec.kind === "youtube") {
      yt = spawn(ytDlpBin(env), buildYtDlpArgs(spec.url, spec.format), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    }
    const ff = spawn(ffmpegBin(env), ffArgs, {
      stdio: [yt ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.procs = yt ? [yt, ff] : [ff];

    if (yt) {
      yt.stdout!.pipe(ff.stdin!);
      // ffmpeg morreu antes do yt-dlp: ignora EPIPE, o close do ffmpeg decide
      ff.stdin!.on("error", () => {});
      this.captureStderr(yt, "yt-dlp");
      yt.on("error", (err) => this.log(`yt-dlp: ${err.message}`));
      yt.on("close", (code) => {
        if (gen !== this.generation || this.stopping) return;
        this.log(`yt-dlp saiu (código ${code})`);
        ff.stdin?.end();
      });
    }
    this.captureStderr(ff, "ffmpeg");
    ff.on("error", (err) => this.log(`ffmpeg: ${err.message}`));
    ff.stdout!.on("data", (d: Buffer) => {
      if (gen === this.generation) this.onData(d);
    });
    if (this.paused) ff.stdout!.pause();
    ff.on("close", (code, signal) => {
      if (gen !== this.generation) return;
      yt?.kill();
      this.onPipelineClosed(code, signal);
    });
  }

  private onPipelineClosed(code: number | null, signal: NodeJS.Signals | null): void {
    this.flushCarry();
    this.procs = [];
    if (this.stopping) {
      this.emit("end");
      return;
    }
    if (!this.live) {
      if (code === 0) this.emit("end");
      else this.emit("fatal", new Error(`ffmpeg falhou (código ${code ?? signal}): ${this.stderrTail.slice(-3).join(" | ")}`));
      return;
    }
    // fonte ao vivo: reinicia. Se rodou bem por 1 min, recomeça o backoff.
    if (Date.now() - this.startedAt > 60_000) this.backoff.reset();
    const delayMs = this.backoff.next();
    this.restarts++;
    const reason = `processo saiu (código ${code ?? signal})${this.stderrTail.length ? `: ${this.stderrTail[this.stderrTail.length - 1]}` : ""}`;
    this.emit("restart", { attempt: this.backoff.attempts, delayMs, reason });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnPipeline();
    }, delayMs);
  }

  private onData(d: Buffer): void {
    const now = Date.now();
    // Buraco desde o último dado (reinício de live): preenche com silêncio
    // para t continuar acompanhando o tempo real.
    if (this.live && this.lastDataWall > 0) {
      const gapS = (now - this.lastDataWall) / 1000;
      if (gapS > 1) {
        const fill = Math.min(gapS, this.opts.maxGapFillS ?? 30);
        const bytes = Math.floor(fill * BYTES_PER_SECOND / CHUNK_BYTES) * CHUNK_BYTES;
        if (bytes > 0) {
          this.log(`buraco de ${gapS.toFixed(1)} s na fonte; inserindo ${(bytes / BYTES_PER_SECOND).toFixed(1)} s de silêncio`);
          this.emitPcm(Buffer.alloc(bytes));
        }
      }
    }
    this.lastDataWall = now;
    this.emitPcm(d);
  }

  /** Corta em pedaços de 100 ms alinhados a sample. */
  private emitPcm(d: Buffer): void {
    let buf = this.carry.length ? Buffer.concat([this.carry, d]) : d;
    while (buf.length >= CHUNK_BYTES) {
      const chunk = buf.subarray(0, CHUNK_BYTES);
      buf = buf.subarray(CHUNK_BYTES);
      this.emitChunk(Buffer.from(chunk));
    }
    this.carry = Buffer.from(buf);
  }

  private flushCarry(): void {
    const even = this.carry.length - (this.carry.length % 2);
    if (even > 0) this.emitChunk(Buffer.from(this.carry.subarray(0, even)));
    this.carry = Buffer.alloc(0);
  }

  private emitChunk(chunk: Buffer): void {
    const t = this.clock;
    this.bytes += chunk.length;
    this.updateLevel(chunk);
    this.emit("chunk", chunk, t);
  }

  private updateLevel(chunk: Buffer): void {
    const n = Math.floor(chunk.length / 2);
    for (let i = 0; i < n; i++) {
      const s = chunk.readInt16LE(i * 2) / 32768;
      this.levelAcc.sum += s * s;
    }
    this.levelAcc.n += n;
    if (this.levelAcc.n >= SAMPLE_RATE) {
      const rms = Math.sqrt(this.levelAcc.sum / this.levelAcc.n);
      this._levelDb = rms > 0 ? Math.max(-90, 20 * Math.log10(rms)) : -90;
      this.levelAcc = { sum: 0, n: 0 };
    }
  }

  private captureStderr(p: ChildProcess, name: string): void {
    let partial = "";
    p.stderr?.setEncoding("utf8");
    p.stderr?.on("data", (s: string) => {
      const lines = (partial + s).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const l = `${name}: ${line.trim()}`;
        this.stderrTail.push(l);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        this.log(l);
      }
    });
  }

  private log(line: string): void {
    this.emit("log", line);
  }
}
