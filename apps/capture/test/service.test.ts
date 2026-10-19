import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  daemonArgv,
  ensureEnvFile,
  envFileTemplate,
  installPlan,
  launchdPlist,
  systemdUnit,
  uninstallPlan,
  windowsTaskXml,
  type ServiceContext,
} from "../src/service";

const mac: ServiceContext = {
  platform: "darwin",
  home: "/Users/pedro",
  name: "mac-sala",
  nodePath: "/opt/homebrew/bin/node",
  tsxImport: "file:///Users/pedro/actually/apps/capture/node_modules/tsx/dist/loader.mjs",
  cliPath: "/Users/pedro/actually/apps/capture/src/cli.ts",
  workDir: "/Users/pedro/actually/apps/capture",
  logDir: "/Users/pedro/.actually/logs",
  pathEnv: "/usr/bin:/bin",
  uid: 501,
};

const linux: ServiceContext = {
  ...mac,
  platform: "linux",
  home: "/home/pedro",
  name: "nuc sala",
  nodePath: "/usr/bin/node",
  cliPath: "/home/pedro/actually/apps/capture/src/cli.ts",
  workDir: "/home/pedro/actually/apps/capture",
  logDir: "/home/pedro/.actually/logs",
  uid: 1000,
};

const win: ServiceContext = {
  ...mac,
  platform: "win32",
  home: "C:\\Users\\pedro",
  name: "pc-sala",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  cliPath: "C:\\actually\\apps\\capture\\src\\cli.ts",
  workDir: "C:\\actually\\apps\\capture",
  logDir: "C:\\Users\\pedro\\.actually\\logs",
  pathEnv: "C:\\Windows",
  winUser: "SALA\\pedro",
};

describe("macOS (launchd)", () => {
  const plist = launchdPlist(mac);
  it("envolve com caffeinate -is e roda o daemon", () => {
    expect(plist).toContain("<string>/usr/bin/caffeinate</string>\n    <string>-is</string>\n    <string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>daemon</string>\n    <string>--name</string>\n    <string>mac-sala</string>");
  });
  it("RunAtLoad e KeepAlive", () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });
  it("PATH inclui o Homebrew para achar ffmpeg/yt-dlp", () => {
    expect(plist).toContain("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  });
  it("plano: grava o plist e faz bootstrap no domínio do usuário", () => {
    const plan = installPlan(mac);
    expect(plan.files[0]!.path).toBe("/Users/pedro/Library/LaunchAgents/ai.actually.capture.plist");
    expect(plan.commands.map((c) => c.args[0])).toEqual(["bootout", "bootstrap", "enable", "kickstart"]);
    expect(plan.commands[1]!.args).toEqual(["bootstrap", "gui/501", plan.files[0]!.path]);
    expect(plan.commands[0]!.ignoreFailure).toBe(true);
    expect(plan.notes.join(" ")).toMatch(/autorestart/);
  });
  it("uninstall remove o plist", () => {
    const plan = uninstallPlan(mac);
    expect(plan.remove).toEqual(["/Users/pedro/Library/LaunchAgents/ai.actually.capture.plist"]);
  });
  it("escapa XML", () => {
    expect(launchdPlist({ ...mac, name: "a&b<c>" })).toContain("<string>a&amp;b&lt;c&gt;</string>");
  });
});

describe("Linux (systemd --user)", () => {
  const unit = systemdUnit(linux);
  it("Restart=always e encerramento limpo com SIGINT", () => {
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("KillSignal=SIGINT");
    expect(unit).toContain("WantedBy=default.target");
  });
  it("ExecStart com aspas em argumentos com espaço", () => {
    expect(unit).toContain('ExecStart=/usr/bin/node --import file:///');
    expect(unit).toContain('daemon --name "nuc sala" --log-dir /home/pedro/.actually/logs');
  });
  it("plano e instruções de linger/inhibit", () => {
    const plan = installPlan(linux);
    expect(plan.files[0]!.path).toBe("/home/pedro/.config/systemd/user/actually-capture.service");
    expect(plan.commands.map((c) => c.args.join(" "))).toEqual([
      "--user daemon-reload",
      "--user enable actually-capture.service",
      "--user restart actually-capture.service",
    ]);
    const notes = plan.notes.join(" ");
    expect(notes).toContain("loginctl enable-linger");
    expect(notes).toContain("systemd-inhibit");
  });
});

describe("Windows (Tarefa Agendada)", () => {
  const xml = windowsTaskXml(win);
  it("no logon, reinicia em falha, sem limite de tempo e sem parar na bateria", () => {
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<UserId>SALA\\pedro</UserId>");
    expect(xml).toMatch(/<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>/);
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
  });
  it("comando com aspas e --supervise", () => {
    expect(xml).toContain("<Command>&quot;C:\\Program Files\\nodejs\\node.exe&quot;</Command>");
    expect(xml).toMatch(/<Arguments>--import file:\/\/\/\S+ C:\\actually\\apps\\capture\\src\\cli\.ts daemon --name pc-sala --log-dir \S+ --supervise<\/Arguments>/);
  });
  it("plano usa schtasks /XML e grava em UTF-16", () => {
    const plan = installPlan(win);
    expect(plan.files[0]!.encoding).toBe("utf16le");
    expect(plan.commands[0]).toEqual({ cmd: "schtasks", args: ["/Create", "/TN", "actually-capture", "/XML", plan.files[0]!.path, "/F"] });
    expect(plan.notes.join(" ")).toContain("powercfg");
    expect(uninstallPlan(win).commands[0]!.args).toEqual(["/Delete", "/TN", "actually-capture", "/F"]);
  });
});

describe("arquivo de variáveis", () => {
  it("template com as três variáveis", () => {
    const t = envFileTemplate("https://actually.vercel.app");
    expect(t).toContain("ACTUALLY_API_URL=https://actually.vercel.app");
    expect(t).toContain("INGEST_TOKEN=");
    expect(t).toContain("DEEPGRAM_API_KEY=");
  });

  it("cria com permissão 600 e não sobrescreve", () => {
    const home = mkdtempSync(join(tmpdir(), "capture-home-"));
    expect(ensureEnvFile(home, null)).toBe(true);
    const path = join(home, ".actually", "capture.env");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(ensureEnvFile(home, "outra")).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("ACTUALLY_API_URL=\n");
  });

  it("daemonArgv", () => {
    expect(daemonArgv(mac).slice(3)).toEqual(["/Users/pedro/actually/apps/capture/src/cli.ts", "daemon", "--name", "mac-sala", "--log-dir", "/Users/pedro/.actually/logs"]);
  });
});
