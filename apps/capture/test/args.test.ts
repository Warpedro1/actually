import { describe, expect, it } from "vitest";
import { CliError, parseCli } from "../src/args";

const ENV = { ACTUALLY_API_URL: "https://actually.vercel.app" };

describe("parsing de argumentos", () => {
  it("run youtube com defaults", () => {
    const c = parseCli(["run", "--debate", "debate-23-10", "--name", "mac-pedro", "--source", "youtube", "--url", "https://youtu.be/x"], ENV);
    expect(c).toEqual({
      cmd: "run",
      args: {
        debate: "debate-23-10",
        name: "mac-pedro",
        role: "primary",
        source: { kind: "youtube", url: "https://youtu.be/x", format: "bestaudio/best" },
        api: "https://actually.vercel.app",
        sttModel: "nova-3",
        sttFallbackModel: "nova-2",
        dryRun: false,
        logDir: "./capture-logs",
      },
    });
  });

  it("aceita o '--' que o pnpm repassa", () => {
    const c = parseCli(["--", "devices"], ENV);
    expect(c).toEqual({ cmd: "devices" });
  });

  it("run device standby com --api e --stt-model", () => {
    const c = parseCli(
      ["run", "--debate", "d", "--name", "pc", "--role", "standby", "--source", "device", "--device", ":1", "--api", "http://localhost:3000", "--stt-model", "nova-2"],
      {},
    );
    if (c.cmd !== "run") throw new Error("esperava run");
    expect(c.args.role).toBe("standby");
    expect(c.args.source).toEqual({ kind: "device", device: ":1" });
    expect(c.args.api).toBe("http://localhost:3000");
    expect(c.args.sttModel).toBe("nova-2");
  });

  it("replay de arquivo: tempo real por padrão, --no-realtime desliga", () => {
    const base = ["run", "--debate", "d", "--name", "n", "--source", "file", "--file", "ontem.mp4"];
    const rt = parseCli(base, ENV);
    const fast = parseCli([...base, "--no-realtime"], ENV);
    if (rt.cmd !== "run" || fast.cmd !== "run") throw new Error();
    expect(rt.args.source).toEqual({ kind: "file", path: "ontem.mp4", realtime: true });
    expect(fast.args.source).toEqual({ kind: "file", path: "ontem.mp4", realtime: false });
  });

  it("--dry-run dispensa API", () => {
    const c = parseCli(["run", "--debate", "d", "--name", "n", "--source", "file", "--file", "a.wav", "--dry-run"], {});
    if (c.cmd !== "run") throw new Error();
    expect(c.args.dryRun).toBe(true);
    expect(c.args.api).toBeNull();
  });

  it("erros de uso", () => {
    expect(() => parseCli(["run", "--name", "n", "--source", "file", "--file", "a"], ENV)).toThrow(/--debate/);
    expect(() => parseCli(["run", "--debate", "d", "--source", "file", "--file", "a"], ENV)).toThrow(/--name/);
    expect(() => parseCli(["run", "--debate", "d", "--name", "n", "--source", "youtube"], ENV)).toThrow(/--url/);
    expect(() => parseCli(["run", "--debate", "d", "--name", "n", "--source", "device"], ENV)).toThrow(/--device/);
    expect(() => parseCli(["run", "--debate", "d", "--name", "n", "--source", "radio"], ENV)).toThrow(/inválido/);
    expect(() => parseCli(["run", "--debate", "d", "--name", "n", "--source", "file", "--file", "a", "--role", "x"], ENV)).toThrow(/--role/);
    expect(() => parseCli(["run", "--debate", "d", "--name", "n", "--source", "file", "--file", "a"], {})).toThrow(/--api/);
    expect(() => parseCli(["run", "--debate", "d", "--bogus"], ENV)).toThrow(CliError);
    expect(() => parseCli(["voar"], ENV)).toThrow(/desconhecido/);
  });

  it("doctor, daemon e serviço", () => {
    expect(parseCli(["doctor", "--device", ":0"], ENV)).toEqual({
      cmd: "doctor",
      api: "https://actually.vercel.app",
      url: null,
      device: ":0",
      ytdlpFormat: "bestaudio/best",
    });
    expect(parseCli(["daemon", "--name", "mac-sala"], ENV)).toEqual({
      cmd: "daemon",
      name: "mac-sala",
      api: "https://actually.vercel.app",
      logDir: "./capture-logs",
      supervise: false,
    });
    expect(parseCli(["install-service", "--name", "mac-sala", "--print"], {})).toMatchObject({ cmd: "install-service", print: true });
    expect(parseCli(["uninstall-service"], {})).toEqual({ cmd: "uninstall-service", print: false });
    expect(parseCli([], {})).toEqual({ cmd: "help" });
  });
});
