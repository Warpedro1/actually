// Fonte de áudio: ffmpeg (e yt-dlp, para o YouTube) → PCM s16le 16 kHz mono.
//
// A montagem de argumentos é pura (testada por SO/fonte). A classe AudioSource
// cuida dos processos: reinicia com backoff quando uma fonte ao vivo cai (ou,
// no dispositivo, fica muda — watchdog) e mantém a linha do tempo contínua (t
// só cresce). Só um buraco real (reinício do processo) vira silêncio: um
// separador curto e, se t ficou atrás do relógio de parede, o que faltar para
// alcançá-lo — as pausas normais entre fragmentos do HLS nunca viram silêncio.
// t pode ficar adiantado em relação ao relógio: a rajada da borda da live
// (~12 s no HLS) e o separador de cada reinício não são descontados.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
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

const YOUTUBE_HOST_RE = /^(?:(?:www|m|music)\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?youtube-nocookie\.com$/;

/**
 * Por que a URL não pode ir para o yt-dlp (null = pode). Só http(s) de host do
 * YouTube, sem espaço/controle, usuário, senha ou porta. A URL vem do /admin:
 * sem isso, um valor como "--update-to=..." ou "--exec ..." viraria opção do
 * yt-dlp na máquina de captura.
 */
export function youtubeUrlError(url: string): string | null {
  if (url.startsWith("-")) return "URL não pode começar com '-'";
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return "URL com espaço ou caractere de controle";
  if (!/^https?:\/\//i.test(url)) return "URL precisa começar com http:// ou https://";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "URL inválida";
  }
  if (u.username || u.password || u.port) return "URL não pode ter usuário, senha ou porta";
  if (!YOUTUBE_HOST_RE.test(u.hostname)) return `host não é do YouTube (${u.hostname})`;
  return null;
}

/** Por que a fonte não pode ser aberta (null = pode). Barreira antes de qualquer spawn. */
export function sourceSpecError(spec: SourceSpec): string | null {
  switch (spec.kind) {
    case "youtube": {
      const err = youtubeUrlError(spec.url);
      return err ? `URL do YouTube recusada: ${err}` : null;
    }
    case "file":
      if (spec.path.startsWith("-")) return "caminho do arquivo não pode começar com '-'";
      if (/[\u0000-\u001f\u007f]/.test(spec.path)) return "caminho do arquivo com caractere de controle";
      return null;
    case "device":
      return null;
  }
}

/**
 * Argumentos do yt-dlp. `extra` (ex.: --print do doctor) entra antes do "--";
 * a URL vem sempre depois dele, então nunca é lida como opção.
 */
export function buildYtDlpArgs(url: string, format: string = DEFAULT_YTDLP_FORMAT, extra: string[] = []): string[] {
  return ["-f", format, "--no-part", "--no-playlist", "--quiet", "--no-warnings", "-o", "-", ...extra, "--", url];
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
  /**
   * Erro fatal: arquivo inválido ou fonte recusada (URL/caminho) antes de
   * qualquer spawn. Fora isso, fontes ao vivo nunca emitem, só reiniciam.
   */
  fatal: [err: Error];
  log: [line: string];
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface AudioSourceOptions {
  spec: SourceSpec;
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  /** Máximo de silêncio inserido num reinício (s). */
  maxGapFillS?: number;
  /**
   * Após um reinício, só preenche o atraso de t em relação ao relógio de
   * parede se ele passar disto (s). Abaixo, o atraso fica (t nunca adianta).
   */
  minGapFillS?: number;
  /**
   * Silêncio mínimo inserido em todo reinício (s), para o STT fechar a frase
   * em vez de emendar áudio de antes e de depois do buraco.
   */
  restartSilenceS?: number;
  /**
   * Dispositivo que já mandou áudio e fica este tempo sem nenhum byte é morto
   * e reiniciado (ms). Não vale para o YouTube: lá o processo novo reemitiria
   * áudio já enviado (veja restartsReplayAudio).
   */
  stallTimeoutMs?: number;
  /**
   * Fonte ao vivo cujo processo atual ainda não mandou nenhum byte por este
   * tempo é reiniciada (o yt-dlp demora a resolver a live) (ms). Vale também
   * para o YouTube: matar um processo que não emitiu nada não repete áudio.
   */
  startupTimeoutMs?: number;
  /** Para testes. */
  spawn?: SpawnFn;
}

export const DEFAULT_MAX_GAP_FILL_S = 30;
export const DEFAULT_MIN_GAP_FILL_S = 3;
export const DEFAULT_RESTART_SILENCE_S = 1.5;
export const DEFAULT_SOURCE_STALL_MS = 20_000;
export const DEFAULT_SOURCE_STARTUP_MS = 60_000;

/**
 * Reiniciar esta fonte reemite áudio já enviado? No YouTube (HLS) sim: o
 * processo novo começa uns fragmentos antes da borda da live (~12 s), e com a
 * playlist parada sem ENDLIST esse trecho é o mesmo que já saiu. Como t só
 * cresce, o segmentador não o reconhece e o pipeline o trataria como a mesma
 * afirmação dita de novo ("Repetido", sem HITL). Por isso o watchdog nunca
 * mata uma live do YouTube que já mandou áudio: se a playlist voltar a andar,
 * o mesmo processo continua sem repetir nada. (Se o próprio ffmpeg do yt-dlp
 * desistir da playlist parada e sair, o reinício normal ainda reemite a cauda
 * — limitação conhecida, fora do watchdog.) Um dispositivo não tem passado
 * para reemitir.
 */
export function restartsReplayAudio(spec: SourceSpec): boolean {
  return spec.kind === "youtube";
}

export class AudioSource extends EventEmitter<AudioSourceEvents> {
  private procs: ChildProcess[] = [];
  private generation = 0;
  private stopping = false;
  private paused = false;
  private bytes = 0; // total já emitido (define t)
  private carry = Buffer.alloc(0);
  /** Relógio de parede do 1º dado: âncora de t (t ≈ agora − âncora). */
  private firstDataWall = 0;
  private lastDataWall = 0;
  /** Geração (processo) do último dado: mudou ⇒ houve reinício. */
  private lastDataGen = 0;
  /** Último dado ou spawn — base do watchdog de fonte muda. */
  private lastActivityWall = 0;
  /** O processo atual já mandou algum byte. */
  private genHasData = false;
  private watchdog: NodeJS.Timeout | null = null;
  private killReason: string | null = null;
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
    const err = sourceSpecError(this.opts.spec);
    if (err) {
      // nunca chama yt-dlp/ffmpeg com entrada recusada (vale também para live)
      process.nextTick(() => this.emit("fatal", new Error(err)));
      return;
    }
    if (this.live) this.startWatchdog();
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
    this.stopWatchdog();
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
    const spawnFn: SpawnFn = this.opts.spawn ?? spawn;
    const gen = ++this.generation;
    this.startedAt = Date.now();
    this.lastActivityWall = this.startedAt;
    this.genHasData = false;
    this.killReason = null;
    this.carry = Buffer.alloc(0);

    const ffArgs = buildFfmpegArgs(spec, platform);
    let yt: ChildProcess | null = null;
    if (spec.kind === "youtube") {
      yt = spawnFn(ytDlpBin(env), buildYtDlpArgs(spec.url, spec.format), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    }
    const ff = spawnFn(ffmpegBin(env), ffArgs, {
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
      if (gen === this.generation) this.onData(d, gen);
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
    const reason =
      this.killReason ??
      `processo saiu (código ${code ?? signal})${this.stderrTail.length ? `: ${this.stderrTail[this.stderrTail.length - 1]}` : ""}`;
    this.emit("restart", { attempt: this.backoff.attempts, delayMs, reason });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnPipeline();
    }, delayMs);
  }

  private onData(d: Buffer, gen: number): void {
    const now = Date.now();
    this.lastActivityWall = now;
    this.genHasData = true;
    if (this.firstDataWall === 0) {
      this.firstDataWall = now;
    } else if (this.live && gen !== this.lastDataGen) {
      // Só o 1º dado de um processo novo (reinício) indica buraco real. Pausas
      // entre rajadas do mesmo processo (fragmentos do HLS chegam de uma vez a
      // cada 2–5 s) são normais e nunca viram silêncio.
      this.fillRestartGap(now);
    }
    this.lastDataWall = now;
    this.lastDataGen = gen;
    this.emitPcm(d);
  }

  /**
   * Silêncio no reinício de uma fonte ao vivo. Preenche o atraso de t em
   * relação ao relógio de parede (desde o 1º dado) só se passar de
   * minGapFillS, sem exceder o tempo parado nem maxGapFillS — no HLS o
   * processo novo recomeça uns fragmentos antes da borda da live, então o
   * déficit costuma ser menor que o tempo parado, e preencher o tempo parado
   * inteiro adiantaria t. Sempre insere ao menos restartSilenceS para o STT
   * não emendar numa frase o áudio de antes e de depois do buraco.
   */
  private fillRestartGap(now: number): void {
    const gapS = (now - this.lastDataWall) / 1000;
    const deficitS = (now - this.firstDataWall) / 1000 - this.clock;
    const minFill = this.opts.minGapFillS ?? DEFAULT_MIN_GAP_FILL_S;
    const catchUp = deficitS >= minFill ? Math.min(deficitS, gapS) : 0;
    const separator = this.opts.restartSilenceS ?? DEFAULT_RESTART_SILENCE_S;
    const fillS = Math.min(this.opts.maxGapFillS ?? DEFAULT_MAX_GAP_FILL_S, Math.max(separator, catchUp));
    const bytes = Math.floor((fillS * BYTES_PER_SECOND) / CHUNK_BYTES) * CHUNK_BYTES;
    if (bytes <= 0) return;
    this.log(
      `fonte reiniciada após ${gapS.toFixed(1)} s (atraso de ${deficitS.toFixed(1)} s no relógio); inserindo ${(bytes / BYTES_PER_SECOND).toFixed(1)} s de silêncio`,
    );
    this.emitPcm(Buffer.alloc(bytes));
  }

  /**
   * Fonte ao vivo muda: processo que nunca mandou nenhum byte (yt-dlp preso
   * resolvendo a live, dispositivo que não abriu) é reiniciado; dispositivo que
   * mandou áudio e travou também. Live do YouTube que mandou áudio e parou
   * (playlist sem ENDLIST) não: reiniciar repetiria áudio já enviado, a cada
   * novo travamento (restartsReplayAudio). Fica muda até a playlist voltar a
   * andar ou o yt-dlp sair sozinho; o /admin mostra a fonte em silêncio e o
   * operador decide (runbook: tornar a reserva ativa, trocar a URL).
   */
  private startWatchdog(): void {
    const stallMs = this.opts.stallTimeoutMs ?? DEFAULT_SOURCE_STALL_MS;
    const startupMs = Math.max(stallMs, this.opts.startupTimeoutMs ?? DEFAULT_SOURCE_STARTUP_MS);
    const restartOnStall = !restartsReplayAudio(this.opts.spec);
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (this.stopping || this.procs.length === 0 || this.killReason) return;
      if (this.genHasData && !restartOnStall) return;
      const idleMs = Date.now() - this.lastActivityWall;
      if (idleMs >= (this.genHasData ? stallMs : startupMs)) this.killPipeline(`fonte sem áudio há ${(idleMs / 1000).toFixed(0)} s`);
    }, Math.min(1000, stallMs));
    this.watchdog.unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** Mata o pipeline atual; o close do ffmpeg reinicia com backoff (onPipelineClosed). */
  private killPipeline(reason: string): void {
    this.killReason = reason;
    this.log(`${reason}; reiniciando`);
    const procs = this.procs;
    for (const p of procs) p.kill();
    const t = setTimeout(() => {
      for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }, 3000);
    t.unref?.();
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
