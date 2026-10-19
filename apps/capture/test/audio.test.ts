import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AudioSource,
  BYTES_PER_SECOND,
  DEFAULT_RESTART_SILENCE_S,
  buildFfmpegArgs,
  buildProbeArgs,
  buildYtDlpArgs,
  deviceInputArgs,
  levelDbfs,
  listDevicesCommands,
  peakDbfs,
  sourceSpecError,
  youtubeUrlError,
  type SourceSpec,
  type SpawnFn,
} from "../src/audio";

const OUT = ["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"];

describe("[RF01] argumentos do ffmpeg (youtube, dispositivo, arquivo)", () => {
  it("youtube: lê do stdout do yt-dlp", () => {
    expect(buildFfmpegArgs({ kind: "youtube", url: "u", format: "bestaudio/best" }, "linux")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      "pipe:0",
      ...OUT,
    ]);
  });

  it("arquivo em tempo real usa -re; --no-realtime não", () => {
    const rt = buildFfmpegArgs({ kind: "file", path: "/x/debate.mp4", realtime: true }, "darwin");
    expect(rt.slice(4)).toEqual(["-re", "-i", "/x/debate.mp4", ...OUT]);
    const fast = buildFfmpegArgs({ kind: "file", path: "C:\\d\\debate.mp4", realtime: false }, "win32");
    expect(fast).not.toContain("-re");
    expect(fast.slice(4)).toEqual(["-i", "C:\\d\\debate.mp4", ...OUT]);
  });

  it("dispositivo por SO", () => {
    expect(deviceInputArgs(":1", "darwin")).toEqual(["-f", "avfoundation", "-i", ":1"]);
    expect(deviceInputArgs("2", "darwin")).toEqual(["-f", "avfoundation", "-i", ":2"]);
    expect(deviceInputArgs("alsa_output.pci.analog-stereo.monitor", "linux")).toEqual([
      "-f",
      "pulse",
      "-i",
      "alsa_output.pci.analog-stereo.monitor",
    ]);
    expect(deviceInputArgs("alsa:hw:1,0", "linux")).toEqual(["-f", "alsa", "-i", "hw:1,0"]);
    expect(deviceInputArgs("audio=Mixagem estéreo (Realtek)", "win32")).toEqual(["-f", "dshow", "-i", "audio=Mixagem estéreo (Realtek)"]);
    expect(deviceInputArgs("CABLE Output (VB-Audio)", "win32")).toEqual(["-f", "dshow", "-i", "audio=CABLE Output (VB-Audio)"]);
  });

  it("device completo inclui saída PCM 16k mono", () => {
    const args = buildFfmpegArgs({ kind: "device", device: ":0" }, "darwin");
    expect(args.slice(-OUT.length)).toEqual(OUT);
    expect(args).toContain("avfoundation");
  });

  it("probe do doctor grava N segundos", () => {
    const args = buildProbeArgs("default", "linux", 3);
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("3");
  });

  it("yt-dlp manda para o stdout", () => {
    const args = buildYtDlpArgs("https://youtu.be/x");
    expect(args.slice(0, 2)).toEqual(["-f", "bestaudio/best"]);
    expect(args.slice(-4)).toEqual(["-o", "-", "--", "https://youtu.be/x"]);
  });

  it("listagem de dispositivos por SO", () => {
    expect(listDevicesCommands("darwin")[0]!.args).toContain("avfoundation");
    expect(listDevicesCommands("win32")[0]!.args).toContain("dshow");
    expect(listDevicesCommands("linux").map((c) => c.cmd)).toEqual(["ffmpeg", "pactl"]);
  });
});

describe("nível de áudio", () => {
  it("silêncio = -90 dBFS", () => {
    expect(levelDbfs(Buffer.alloc(3200))).toBe(-90);
    expect(peakDbfs(Buffer.alloc(3200))).toBe(-90);
  });

  it("onda quadrada em meia escala ≈ -6 dBFS", () => {
    const buf = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) buf.writeInt16LE(i % 2 ? 16384 : -16384, i * 2);
    expect(levelDbfs(buf)).toBeCloseTo(-6.02, 1);
    expect(peakDbfs(buf)).toBeCloseTo(-6.02, 1);
  });
});

describe("[RNF05] [RF13] URL da fonte nunca vira opção do yt-dlp/ffmpeg", () => {
  it("a URL vai sempre depois de \"--\"; opções extras (doctor) antes", () => {
    const args = buildYtDlpArgs("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "bestaudio", ["--print", "%(title)s"]);
    expect(args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    expect(args.indexOf("--print")).toBeLessThan(args.indexOf("--"));
  });

  it("aceita só http(s) de host do YouTube", () => {
    for (const ok of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/live/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "http://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/@canal/live",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ]) {
      expect(youtubeUrlError(ok), ok).toBeNull();
    }
    for (const bad of [
      "--update-to=atacante/repo@v1",
      "--config-locations=\\\\host\\share",
      "-x",
      " https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ --exec x",
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com@evil.com/watch",
      "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "file:///etc/passwd",
      "ftp://youtube.com/x",
      "javascript:alert(1)",
      "youtube.com/watch?v=dQw4w9WgXcQ",
      "",
    ]) {
      expect(youtubeUrlError(bad), bad).not.toBeNull();
    }
  });

  it("caminho de arquivo começando com \"-\" é recusado", () => {
    expect(sourceSpecError({ kind: "file", path: "-i", realtime: true })).not.toBeNull();
    expect(sourceSpecError({ kind: "file", path: "/x/debate.mp4", realtime: true })).toBeNull();
    expect(sourceSpecError({ kind: "device", device: ":0" })).toBeNull();
  });

  it("AudioSource com URL recusada não executa nada e emite fatal", async () => {
    const spawned: string[] = [];
    const src = new AudioSource({
      spec: { kind: "youtube", url: "--update-to=atacante/repo@v1", format: "bestaudio/best" },
      spawn: ((cmd: string) => {
        spawned.push(cmd);
        return new FakeProc() as unknown as ChildProcess;
      }) as SpawnFn,
    });
    const fatal = new Promise<Error>((r) => src.once("fatal", r));
    src.start();
    expect((await fatal).message).toMatch(/recusada/);
    expect(spawned).toEqual([]);
  });
});

/** Processo falso: stdout/stderr/stdin de verdade, close sob demanda. */
class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: (NodeJS.Signals | undefined)[] = [];
  kill(sig?: NodeJS.Signals): boolean {
    this.kills.push(sig);
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = sig ?? "SIGTERM";
      this.emit("close", null, this.signalCode);
    }
    return true;
  }
  exit(code: number): void {
    this.exitCode = code;
    this.emit("close", code, null);
  }
  /** `seconds` de PCM não nulo saindo do stdout (ffmpeg). */
  pcm(seconds: number): void {
    this.stdout.emit("data", Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND), 7));
  }
}

function fakeSource(spec: SourceSpec, opts: { stallTimeoutMs?: number; startupTimeoutMs?: number } = {}) {
  const procs: { cmd: string; args: string[]; p: FakeProc }[] = [];
  const src = new AudioSource({
    spec,
    ...opts,
    env: { FFMPEG_PATH: "ffmpeg", YTDLP_PATH: "yt-dlp" },
    spawn: ((cmd: string, args: string[]) => {
      const p = new FakeProc();
      procs.push({ cmd, args, p });
      return p as unknown as ChildProcess;
    }) as SpawnFn,
  });
  let silence = 0;
  let audio = 0;
  src.on("chunk", (buf) => {
    if (buf.every((b) => b === 0)) silence += buf.length / BYTES_PER_SECOND;
    else audio += buf.length / BYTES_PER_SECOND;
  });
  const logs: string[] = [];
  src.on("log", (l) => logs.push(l));
  const restarts: string[] = [];
  src.on("restart", (r) => restarts.push(r.reason));
  /** ffmpeg da geração atual. */
  const ff = () => procs.filter((x) => x.cmd === "ffmpeg").at(-1)!.p;
  return { src, procs, ff, logs, restarts, totals: () => ({ silence: round1(silence), audio: round1(audio) }) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YT: SourceSpec = { kind: "youtube", url: YT_URL, format: "bestaudio/best" };

describe("[RNF09] linha do tempo da fonte ao vivo", () => {
  afterEach(() => vi.useRealTimers());

  it("rajadas do HLS (4 s de áudio a cada 4 s) não viram silêncio e t não anda mais rápido que o relógio", async () => {
    vi.useFakeTimers();
    const f = fakeSource(YT);
    f.src.start();
    expect(f.procs.map((x) => x.cmd)).toEqual(["yt-dlp", "ffmpeg"]);
    expect(f.procs[0]!.args.slice(-2)).toEqual(["--", YT_URL]);
    const t0 = Date.now();
    f.ff().pcm(12); // borda da live: 3 fragmentos de uma vez
    let maxLead = 0;
    for (let i = 0; i < 15; i++) {
      vi.advanceTimersByTime(4000);
      f.ff().pcm(4);
      maxLead = Math.max(maxLead, f.src.clock - (Date.now() - t0) / 1000);
    }
    expect(f.totals()).toEqual({ silence: 0, audio: 72 });
    expect(f.src.clock).toBeCloseTo(72, 5);
    // adiantado só o que a borda da live já trouxe, sem crescer com o tempo
    expect(maxLead).toBeLessThanOrEqual(12 + 1e-9);
    expect(f.logs.filter((l) => l.includes("silêncio"))).toEqual([]);
    await f.src.stop();
  });

  it("reinício real (dispositivo, 10 s parado): preenche o atraso em relação ao relógio", async () => {
    vi.useFakeTimers();
    const f = fakeSource({ kind: "device", device: ":0" });
    f.src.start();
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      f.ff().pcm(1);
      vi.advanceTimersByTime(1000);
    }
    // t = 10 s, relógio = 10 s; o ffmpeg cai e volta (backoff ~1 s)
    const old = f.ff();
    old.exit(1);
    expect(f.restarts).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(f.ff()).not.toBe(old);
    vi.advanceTimersByTime(20_000 - (Date.now() - t0));
    f.ff().pcm(1);
    // ao voltar (relógio = 20 s) t estava em 10 s: 10 s de silêncio, t alinhado de novo
    expect(f.totals()).toEqual({ silence: 10, audio: 11 });
    expect(f.src.clock).toBeCloseTo(21, 5);
    await f.src.stop();
  });

  it("reinício curto no HLS (processo novo volta com fragmentos já vistos): só o separador mínimo", async () => {
    vi.useFakeTimers();
    const f = fakeSource(YT);
    f.src.start();
    f.ff().pcm(12);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(4000);
      f.ff().pcm(4);
    }
    // relógio 16 s, t 28 s; cai e volta em ~5 s com nova rajada da borda da live
    f.ff().exit(1);
    vi.advanceTimersByTime(5000);
    f.ff().pcm(12);
    expect(f.totals()).toEqual({ silence: DEFAULT_RESTART_SILENCE_S, audio: 40 });
    await f.src.stop();
  });

  it("watchdog: fonte ao vivo sem nenhum byte por N s é morta e reiniciada", async () => {
    vi.useFakeTimers();
    const f = fakeSource(YT, { stallTimeoutMs: 10_000 });
    f.src.start();
    // dados a cada 4 s: nunca dispara
    for (let i = 0; i < 10; i++) {
      f.ff().pcm(4);
      vi.advanceTimersByTime(4000);
    }
    expect(f.restarts).toEqual([]);
    // playlist parou sem ENDLIST: o ffmpeg fica vivo e mudo
    const stuck = f.ff();
    vi.advanceTimersByTime(11_000);
    expect(stuck.kills.length).toBeGreaterThan(0);
    expect(f.restarts).toHaveLength(1);
    expect(f.restarts[0]).toMatch(/sem áudio/);
    vi.advanceTimersByTime(2000);
    expect(f.ff()).not.toBe(stuck);
    await f.src.stop();
  });

  it("processo que nunca manda dados também é reiniciado, com folga para o yt-dlp resolver a live", async () => {
    vi.useFakeTimers();
    const f = fakeSource(YT, { stallTimeoutMs: 5000, startupTimeoutMs: 30_000 });
    f.src.start();
    vi.advanceTimersByTime(29_000);
    expect(f.restarts).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(f.restarts).toHaveLength(1);
    await f.src.stop();
  });
});
