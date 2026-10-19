import { describe, expect, it } from "vitest";
import {
  buildFfmpegArgs,
  buildProbeArgs,
  buildYtDlpArgs,
  deviceInputArgs,
  levelDbfs,
  listDevicesCommands,
  peakDbfs,
} from "../src/audio";

const OUT = ["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"];

describe("argumentos do ffmpeg", () => {
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
    expect(args.slice(-3)).toEqual(["-o", "-", "https://youtu.be/x"]);
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
