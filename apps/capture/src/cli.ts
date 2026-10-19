// Ponto de entrada: `pnpm --filter @actually/capture start -- <comando> ...`

import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, USAGE, parseCli, type RunArgs } from "./args";
import { runDaemon, supervise } from "./daemon";
import { doctor, listDevices } from "./doctor";
import { captureEnvPath, loadEnvFiles } from "./env";
import { startRunner } from "./runner";
import {
  defaultServiceLogDir,
  describePlan,
  ensureEnvFile,
  executePlan,
  installPlan,
  uninstallPlan,
  type ServiceContext,
} from "./service";
import { StatusLine } from "./status";

async function main(argv: string[]): Promise<number> {
  loadEnvFiles();
  let command;
  try {
    command = parseCli(argv);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`erro: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  switch (command.cmd) {
    case "help":
      console.log(USAGE);
      return 0;
    case "run":
      return run(command.args);
    case "doctor":
      return doctor(command);
    case "devices":
      return listDevices();
    case "daemon":
      if (command.supervise) return supervise(argv[0] === "--" ? argv.slice(1) : argv);
      return runDaemon({ name: command.name, api: command.api, logDir: resolve(command.logDir) });
    case "install-service":
    case "uninstall-service": {
      const ctx = serviceContext(command.cmd === "install-service" ? command.name : "", command.cmd === "install-service" ? command.logDir : null);
      if (command.cmd === "install-service") {
        const plan = installPlan(ctx);
        if (command.print) {
          console.log(describePlan(plan));
          return 0;
        }
        if (ensureEnvFile(ctx.home, command.api)) console.log(`criado ${captureEnvPath(ctx.home)} (permissão 600) — preencha as chaves`);
        const failed = executePlan(plan);
        console.log(`\n${plan.notes.map((n) => `• ${n}`).join("\n")}`);
        return failed === 0 ? 0 : 1;
      }
      const plan = uninstallPlan(ctx);
      if (command.print) {
        console.log(describePlan(plan));
        return 0;
      }
      const failed = executePlan(plan);
      for (const n of plan.notes) console.log(`• ${n}`);
      return failed === 0 ? 0 : 1;
    }
  }
}

function serviceContext(name: string, logDir: string | null): ServiceContext {
  const home = homedir();
  const cliPath = fileURLToPath(import.meta.url);
  return {
    platform: process.platform,
    home,
    name,
    nodePath: process.execPath,
    // resolvido a partir do WorkingDirectory (apps/capture): sobrevive a upgrades do tsx
    tsxImport: "tsx",
    cliPath,
    workDir: resolve(cliPath, "..", ".."),
    logDir: logDir ? resolve(logDir) : defaultServiceLogDir(home),
    pathEnv: process.env.PATH ?? "",
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    winUser:
      process.platform === "win32"
        ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${process.env.USERNAME ?? userInfo().username}`
        : undefined,
  };
}

async function run(a: RunArgs): Promise<number> {
  const deepgramKey = process.env.DEEPGRAM_API_KEY;
  if (!deepgramKey) {
    console.error("erro: DEEPGRAM_API_KEY ausente (env, .env ou ~/.actually/capture.env)");
    return 2;
  }
  const token = process.env.INGEST_TOKEN ?? null;
  if (!a.dryRun && !token) {
    console.error("erro: INGEST_TOKEN ausente (ou use --dry-run para só transcrever)");
    return 2;
  }
  const status = new StatusLine(process.stdout);
  const runner = startRunner({
    debate: a.debate,
    name: a.name,
    role: a.role,
    source: a.source,
    apiUrl: a.api,
    dryRun: a.dryRun,
    sttModel: a.sttModel,
    sttFallbackModel: a.sttFallbackModel,
    logDir: resolve(a.logDir),
    deepgramKey,
    ingestToken: token,
    statusLine: status,
  });

  let signals = 0;
  const onSignal = () => {
    signals++;
    if (signals > 1) {
      status.print("forçando saída");
      process.exit(130);
    }
    status.print("encerrando (Ctrl+C de novo força a saída)…");
    void runner.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const exit = await runner.done;
  const s = runner.status();
  console.log(`fim (${exit.reason}${exit.error ? `: ${exit.error}` : ""}). segmentos: ${s.segmentsCreated}, enviados: ${s.segmentsSent}. log: ${s.logPath}`);
  return exit.reason === "fatal" ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
