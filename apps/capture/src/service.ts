// `install-service` / `uninstall-service`: instala o daemon para subir no boot
// (login) e reiniciar se cair. Os arquivos são gerados por funções puras
// (testadas); a execução dos comandos do SO fica em executePlan.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Platform } from "./audio";
import { actuallyHome, captureEnvPath } from "./env";

export const SERVICE_LABEL = "ai.actually.capture";
export const SYSTEMD_UNIT = "actually-capture.service";
export const WINDOWS_TASK = "actually-capture";

export interface ServiceContext {
  platform: Platform;
  home: string;
  /** Nome da máquina (aparece no /admin). */
  name: string;
  nodePath: string;
  /** Especificador do loader do tsx (node --import <isso>), resolvido a partir de workDir. */
  tsxImport: string;
  /** Caminho absoluto de apps/capture/src/cli.ts. */
  cliPath: string;
  /** apps/capture — onde estão os node_modules. */
  workDir: string;
  logDir: string;
  /** PATH no momento da instalação (para achar ffmpeg/yt-dlp). */
  pathEnv: string;
  uid?: number;
  /** DOMÍNIO\usuário (Windows). */
  winUser?: string;
}

export interface PlannedFile {
  path: string;
  content: string;
  encoding?: "utf8" | "utf16le";
}

export interface PlannedCommand {
  cmd: string;
  args: string[];
  /** ex.: bootout de um serviço que ainda não existe */
  ignoreFailure?: boolean;
}

export interface ServicePlan {
  files: PlannedFile[];
  remove: string[];
  commands: PlannedCommand[];
  notes: string[];
}

export function defaultServiceLogDir(home: string): string {
  return join(actuallyHome(home), "logs");
}

/** Linha de comando do daemon (sem caffeinate/supervisão). */
export function daemonArgv(ctx: ServiceContext, extra: string[] = []): string[] {
  return [ctx.nodePath, "--import", ctx.tsxImport, ctx.cliPath, "daemon", "--name", ctx.name, "--log-dir", ctx.logDir, ...extra];
}

export function envFileTemplate(api: string | null): string {
  return [
    "# actually — variáveis do capture daemon. Permissão 600; não versionar nem compartilhar.",
    `ACTUALLY_API_URL=${api ?? ""}`,
    "INGEST_TOKEN=",
    "DEEPGRAM_API_KEY=",
    "# CAPTURE_STT_MODEL=nova-3",
    "",
  ].join("\n");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function servicePath(ctx: ServiceContext): string {
  // launchd/systemd começam com PATH mínimo; Homebrew fica fora dele no macOS
  const extra = ctx.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin", "/usr/bin"];
  // descarta caminhos temporários que o pnpm injeta (node_modules/.bin)
  const parts = ctx.pathEnv.split(":").filter((p) => p && !p.includes("node_modules"));
  for (const e of extra) if (!parts.includes(e)) parts.push(e);
  return parts.join(":");
}

// --- macOS ------------------------------------------------------------------

export function launchdPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function launchdPlist(ctx: ServiceContext): string {
  // caffeinate -is: impede o sono por ociosidade (-i) e do sistema na tomada (-s)
  // enquanto o daemon roda; sai junto com ele.
  const argv = ["/usr/bin/caffeinate", "-is", ...daemonArgv(ctx)];
  const log = join(ctx.logDir, "daemon.out.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(ctx.workDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(servicePath(ctx))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

// --- Linux ------------------------------------------------------------------

export function systemdUnitPath(home: string): string {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT);
}

function systemdQuote(a: string): string {
  return /[\s"\\]/.test(a) ? `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : a;
}

export function systemdUnit(ctx: ServiceContext): string {
  return `[Unit]
Description=actually — daemon de captura (${ctx.name})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${systemdQuote(ctx.workDir)}
Environment=${systemdQuote(`PATH=${servicePath(ctx)}`)}
ExecStart=${daemonArgv(ctx).map(systemdQuote).join(" ")}
Restart=always
RestartSec=5
# SIGINT = encerramento limpo (CloseStream no Deepgram, fila drenada)
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
}

// --- Windows ----------------------------------------------------------------

export function windowsTaskXmlPath(home: string): string {
  return join(actuallyHome(home), `${WINDOWS_TASK}-task.xml`);
}

function winQuote(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

export function windowsTaskXml(ctx: ServiceContext): string {
  // --supervise: o próprio daemon reinicia o processo filho se ele morrer;
  // RestartOnFailure cobre falha ao iniciar a tarefa.
  const [cmd, ...args] = daemonArgv(ctx, ["--supervise"]);
  const user = ctx.winUser ?? "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>actually — daemon de captura (${xml(ctx.name)})</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>${user ? `\n      <UserId>${xml(user)}</UserId>` : ""}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">${user ? `\n      <UserId>${xml(user)}</UserId>` : ""}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(winQuote(cmd!))}</Command>
      <Arguments>${xml(args.map(winQuote).join(" "))}</Arguments>
      <WorkingDirectory>${xml(ctx.workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

// --- planos -------------------------------------------------------------------

const COMMON_NOTES = [
  `Preencha ${"~/.actually/capture.env"} (INGEST_TOKEN, DEEPGRAM_API_KEY, ACTUALLY_API_URL) e reinicie o serviço.`,
  "O controle (iniciar/parar/agendar, fonte, papel) é todo pelo /admin; a máquina só precisa estar ligada e com rede.",
];

export function installPlan(ctx: ServiceContext): ServicePlan {
  switch (ctx.platform) {
    case "darwin": {
      const plist = launchdPlistPath(ctx.home);
      const domain = `gui/${ctx.uid ?? 501}`;
      return {
        files: [{ path: plist, content: launchdPlist(ctx) }],
        remove: [],
        commands: [
          { cmd: "launchctl", args: ["bootout", `${domain}/${SERVICE_LABEL}`], ignoreFailure: true },
          { cmd: "launchctl", args: ["bootstrap", domain, plist] },
          { cmd: "launchctl", args: ["enable", `${domain}/${SERVICE_LABEL}`] },
          { cmd: "launchctl", args: ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`] },
        ],
        notes: [
          ...COMMON_NOTES,
          `Logs: ${join(ctx.logDir, "daemon.out.log")}`,
          "Energia: Ajustes > Bateria/Energia → nunca dormir na tomada; `sudo pmset -a autorestart 1` (religa após queda de energia).",
          "Login automático: Ajustes > Usuários e Grupos > Iniciar sessão automaticamente (indisponível com FileVault ligado) — o LaunchAgent só sobe com o usuário logado.",
          "Atualizações: desligue a instalação automática do macOS até depois do debate.",
          "Captura de dispositivo: o macOS pede permissão de microfone para o node na 1ª vez — rode `capture doctor --device :0` uma vez com alguém na máquina.",
        ],
      };
    }
    case "win32": {
      const xmlPath = windowsTaskXmlPath(ctx.home);
      return {
        files: [{ path: xmlPath, content: windowsTaskXml(ctx), encoding: "utf16le" }],
        remove: [],
        commands: [
          { cmd: "schtasks", args: ["/Create", "/TN", WINDOWS_TASK, "/XML", xmlPath, "/F"] },
          { cmd: "schtasks", args: ["/Run", "/TN", WINDOWS_TASK] },
        ],
        notes: [
          ...COMMON_NOTES,
          "Energia (prompt como administrador): `powercfg /change standby-timeout-ac 0` e `powercfg /change hibernate-timeout-ac 0`.",
          "Login automático: `netplwiz` (desmarcar \"Usuários devem digitar nome e senha\") ou Sysinternals Autologon — a tarefa sobe no logon.",
          "Queda de energia: na BIOS/UEFI, \"Restore on AC power loss\" = Power On.",
          "Windows Update: pause as atualizações até depois do debate (Configurações > Windows Update > Pausar).",
        ],
      };
    }
    default: {
      const unit = systemdUnitPath(ctx.home);
      return {
        files: [{ path: unit, content: systemdUnit(ctx) }],
        remove: [],
        commands: [
          { cmd: "systemctl", args: ["--user", "daemon-reload"] },
          { cmd: "systemctl", args: ["--user", "enable", SYSTEMD_UNIT] },
          { cmd: "systemctl", args: ["--user", "restart", SYSTEMD_UNIT] },
        ],
        notes: [
          ...COMMON_NOTES,
          "Subir no boot sem login: `sudo loginctl enable-linger $USER`.",
          "Suspensão: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` (máquina dedicada), ou rode com `systemd-inhibit --what=sleep:idle` numa sessão logada.",
          "Logs: `journalctl --user -u actually-capture -f`.",
          "Queda de energia: na BIOS/UEFI, \"Restore on AC power loss\" = Power On. Desative unattended-upgrades/reboots automáticos até o debate.",
        ],
      };
    }
  }
}

export function uninstallPlan(ctx: Pick<ServiceContext, "platform" | "home" | "uid">): ServicePlan {
  switch (ctx.platform) {
    case "darwin": {
      const domain = `gui/${ctx.uid ?? 501}`;
      return {
        files: [],
        remove: [launchdPlistPath(ctx.home)],
        commands: [{ cmd: "launchctl", args: ["bootout", `${domain}/${SERVICE_LABEL}`], ignoreFailure: true }],
        notes: [`${captureEnvPath(ctx.home)} foi mantido.`],
      };
    }
    case "win32":
      return {
        files: [],
        remove: [windowsTaskXmlPath(ctx.home)],
        commands: [{ cmd: "schtasks", args: ["/Delete", "/TN", WINDOWS_TASK, "/F"], ignoreFailure: true }],
        notes: [`${captureEnvPath(ctx.home)} foi mantido.`],
      };
    default:
      return {
        files: [],
        remove: [systemdUnitPath(ctx.home)],
        commands: [
          { cmd: "systemctl", args: ["--user", "disable", "--now", SYSTEMD_UNIT], ignoreFailure: true },
          { cmd: "systemctl", args: ["--user", "daemon-reload"], ignoreFailure: true },
        ],
        notes: [`${captureEnvPath(ctx.home)} foi mantido.`],
      };
  }
}

/** Cria ~/.actually/capture.env (600) se não existir. Retorna true se criou. */
export function ensureEnvFile(home: string, api: string | null): boolean {
  const path = captureEnvPath(home);
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, envFileTemplate(api), { mode: 0o600 });
  chmodSync(path, 0o600); // garante mesmo com umask estranha
  return true;
}

export function describePlan(plan: ServicePlan): string {
  const out: string[] = [];
  for (const f of plan.files) out.push(`# arquivo ${f.path}\n${f.content}`);
  for (const r of plan.remove) out.push(`# remover ${r}`);
  for (const c of plan.commands) out.push(`$ ${[c.cmd, ...c.args].join(" ")}`);
  return out.join("\n");
}

/** Executa de verdade (não usado nos testes). Retorna o nº de comandos que falharam. */
export function executePlan(plan: ServicePlan, log: (l: string) => void = console.log): number {
  let failed = 0;
  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    const data = f.encoding === "utf16le" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(f.content, "utf16le")]) : f.content;
    writeFileSync(f.path, data);
    log(`escrito: ${f.path}`);
  }
  for (const r of plan.remove) {
    if (existsSync(r)) {
      rmSync(r);
      log(`removido: ${r}`);
    }
  }
  for (const c of plan.commands) {
    const r = spawnSync(c.cmd, c.args, { stdio: "inherit", windowsHide: true });
    const ok = r.status === 0;
    log(`$ ${[c.cmd, ...c.args].join(" ")} → ${ok ? "ok" : `falhou (${r.error?.message ?? r.status})`}`);
    if (!ok && !c.ignoreFailure) failed++;
  }
  return failed;
}
