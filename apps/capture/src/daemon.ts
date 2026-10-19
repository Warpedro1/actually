// `capture daemon` — roda como serviço e obedece ao /admin.
//
// A cada ~3 s: POST /api/control/poll com o estado reportado; recebe o
// desejado e reconcilia (reconcile.ts). Se a API de controle cair, mantém o
// que está fazendo — perder o canal de controle não pode parar a captura.
// O último desejado fica em disco para sobreviver a um reboot sem rede.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MachineDesired, MachineReported } from "@actually/db";
import { MachineDesiredSchema } from "@actually/db";
import { IngestClient } from "./api";
import { backoffDelay, sleep } from "./backoff";
import { FALLBACK_STT_MODEL, DEFAULT_STT_MODEL } from "./deepgram";
import { actuallyHome } from "./env";
import { LineTail } from "./log";
import { clockOffset, idleReportedState, reconcile, type Decision, type RunSpec } from "./reconcile";
import { startRunner, type RunnerExit, type RunnerHandle } from "./runner";
import { StatusLine } from "./status";
import { VERSION } from "./version";

const POLL_MS = 3000;

export interface DaemonOptions {
  name: string;
  api: string | null;
  logDir: string;
}

export function daemonStatePath(home?: string): string {
  return join(actuallyHome(home), "daemon-state.json");
}

/** savedAt = quando esse desejado chegou (gravado ao mudar), ou null. */
function loadDesired(path: string): { desired: MachineDesired; savedAt: number | null } | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { desired?: unknown; saved_at?: unknown };
    const p = MachineDesiredSchema.safeParse(raw.desired);
    if (!p.success) return null;
    const savedAt = typeof raw.saved_at === "string" ? Date.parse(raw.saved_at) : NaN;
    return { desired: p.data, savedAt: Number.isNaN(savedAt) ? null : savedAt };
  } catch {
    return null;
  }
}

function saveDesired(path: string, desired: MachineDesired): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ desired, saved_at: new Date().toISOString() }, null, 2));
  } catch {
    /* sem disco não é motivo para parar */
  }
}

export async function runDaemon(o: DaemonOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const tail = new LineTail(20, 500);
  const status = new StatusLine(process.stdout);
  // log próprio do daemon (a Tarefa Agendada do Windows não guarda stdout)
  const daemonLog = join(o.logDir, `daemon-${o.name.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.log`);
  try {
    mkdirSync(o.logDir, { recursive: true });
  } catch {
    /* segue só com stdout */
  }
  const say = (l: string) => {
    tail.push(l);
    const stamped = `${new Date().toISOString()} ${l}`;
    status.print(stamped);
    try {
      appendFileSync(daemonLog, `${stamped}\n`);
    } catch {
      /* idem */
    }
  };

  if (!o.api) {
    console.error("daemon: --api <url> (ou ACTUALLY_API_URL) é obrigatório");
    return 2;
  }
  if (!env.INGEST_TOKEN) {
    console.error("daemon: INGEST_TOKEN ausente (veja ~/.actually/capture.env)");
    return 2;
  }
  const client = new IngestClient({ baseUrl: o.api, token: env.INGEST_TOKEN, timeoutMs: 5000 });
  const statePath = daemonStatePath();

  const fromDisk = loadDesired(statePath);
  let desired = fromDisk?.desired ?? null;
  let desiredJson = JSON.stringify(desired);
  /** Quando o desejado atual chegou (relógio do servidor): stop_at já vencido nessa hora é erro, não fim de horário. */
  let desiredSince: number | null = fromDisk?.savedAt ?? null;
  if (desired) say(`estado desejado recuperado do disco: ${desired.state}`);
  let offsetMs = 0;
  let pollOk: boolean | null = null;

  let runner: RunnerHandle | null = null;
  let runnerKey: string | null = null;
  let runnerSpec: RunSpec | null = null;
  let runnerStartedAt = 0;
  let completedKey: string | null = null;
  let retryAt: number | null = null;
  let failures = 0;
  let lastError: string | null = null;
  let lastDecision: Decision = { action: "idle" };
  let lastDecisionLog = "";

  const serverNow = () => Date.now() + offsetMs;

  function reported(): MachineReported {
    const s = runner?.status();
    // runner novo chegou a rodar: o erro anterior já não descreve a máquina
    if (s?.state === "running") lastError = null;
    const state: MachineReported["state"] = s
      ? s.state === "stopped" || s.state === "error"
        ? "stopping"
        : s.state
      : idleReportedState(lastDecision, lastError);
    return {
      state,
      agent_id: s?.agentId ?? null,
      active: s?.active ?? false,
      debate_slug: runnerSpec?.debate_slug ?? null,
      source: runnerSpec?.source.kind ?? null,
      last_segment_at: s?.lastSegmentAt ?? null,
      segments_sent: s?.segmentsSent ?? 0,
      audio_level_db: s?.audioLevelDb ?? null,
      reconnects: s?.reconnects ?? 0,
      error: (s?.error ?? lastError)?.slice(0, 2000) ?? null,
      log_tail: tail.get(),
    };
  }

  function start(spec: RunSpec, key: string): void {
    completedKey = null;
    const deepgramKey = env.DEEPGRAM_API_KEY;
    if (!deepgramKey) {
      onFailure("DEEPGRAM_API_KEY ausente (veja ~/.actually/capture.env)");
      return;
    }
    say(`iniciando captura: ${spec.debate_slug} ${spec.source.kind} (${spec.role})`);
    const h = startRunner({
      debate: spec.debate_slug,
      name: o.name,
      role: spec.role,
      source: spec.source,
      apiUrl: o.api,
      dryRun: false,
      sttModel: env.CAPTURE_STT_MODEL || DEFAULT_STT_MODEL,
      sttFallbackModel: FALLBACK_STT_MODEL,
      logDir: o.logDir,
      deepgramKey,
      ingestToken: env.INGEST_TOKEN ?? null,
      onLine: (l) => tail.push(l),
      statusLine: status,
    });
    runner = h;
    runnerKey = key;
    runnerSpec = spec;
    runnerStartedAt = Date.now();
    void h.done.then((exit) => onRunnerExit(h, key, exit));
  }

  let stoppingRunner: RunnerHandle | null = null;

  function onRunnerExit(h: RunnerHandle, key: string, exit: RunnerExit): void {
    if (h === stoppingRunner || runner !== h) return; // parada pedida por nós
    runner = null;
    runnerKey = null;
    if (exit.reason === "ended") {
      completedKey = key;
      say("fonte terminou (fim do arquivo); aguardando novo comando do /admin");
      return;
    }
    if (Date.now() - runnerStartedAt > 60_000) failures = 0;
    onFailure(exit.error ?? `runner saiu (${exit.reason})`);
  }

  function onFailure(error: string): void {
    failures++;
    lastError = error;
    const delay = backoffDelay(failures, { baseMs: 2000, maxMs: 60_000, jitter: 0.2 });
    retryAt = serverNow() + delay;
    say(`falha: ${error}; nova tentativa em ${(delay / 1000).toFixed(0)} s`);
  }

  async function stopRunner(reason: string): Promise<void> {
    const h = runner;
    if (!h) return;
    say(`parando captura: ${reason}`);
    stoppingRunner = h;
    runner = null;
    runnerKey = null;
    await h.stop();
    runnerSpec = null;
    stoppingRunner = null;
  }

  async function apply(d: Decision): Promise<void> {
    lastDecision = d;
    const desc = d.action === "wait" ? `wait:${d.until}` : d.action;
    if (desc !== lastDecisionLog && d.action !== "keep") {
      if (d.action === "wait") say(`aguardando start_at ${new Date(d.until).toISOString()}`);
      if (d.action === "invalid") say(`configuração inválida no /admin: ${d.error}`);
    }
    lastDecisionLog = desc;
    switch (d.action) {
      case "start":
        start(d.spec, d.key);
        return;
      case "restart":
        await stopRunner("configuração mudou no /admin");
        failures = 0;
        lastError = null;
        retryAt = null;
        start(d.spec, d.key);
        return;
      case "stop":
        await stopRunner(d.reason);
        failures = 0;
        retryAt = null;
        return;
      case "invalid":
        lastError = d.error;
        return;
      case "idle":
        // desejado parado: zera a memória de falhas
        if (desired?.state === "stopped") {
          failures = 0;
          lastError = null;
          retryAt = null;
        }
        return;
      default:
        return;
    }
  }

  let quitting = false;
  const quit = async (sig: string) => {
    if (quitting) process.exit(1);
    quitting = true;
    say(`${sig} recebido; encerrando`);
    await stopRunner("daemon encerrando");
    process.exit(0);
  };
  process.on("SIGINT", () => void quit("SIGINT"));
  process.on("SIGTERM", () => void quit("SIGTERM"));

  say(`daemon ${VERSION} "${o.name}" → ${o.api} (poll a cada ${POLL_MS / 1000} s)`);

  for (;;) {
    const sentAt = Date.now();
    try {
      const res = await client.controlPoll({
        machine_name: o.name,
        platform: process.platform,
        version: VERSION,
        reported: reported(),
      });
      offsetMs = clockOffset(res.server_time, sentAt, Date.now());
      const json = JSON.stringify(res.desired);
      if (json !== desiredJson) {
        desired = res.desired;
        desiredJson = json;
        desiredSince = serverNow();
        saveDesired(statePath, res.desired);
        say(`novo estado desejado: ${json}`);
      }
      if (pollOk === false) say("API de controle de volta");
      pollOk = true;
    } catch (err) {
      if (pollOk !== false) say(`API de controle inacessível (${(err as Error).message}); mantendo o estado atual`);
      pollOk = false;
    }

    if (!quitting) {
      await apply(
        reconcile({ desired, now: serverNow(), runningKey: runnerKey, completedKey, retryAt, desiredSince }),
      );
    }
    await sleep(Math.max(0, POLL_MS - (Date.now() - sentAt)));
  }
}

/**
 * --supervise: processo pai que reinicia o daemon se ele morrer. Usado no
 * Windows, onde a Tarefa Agendada não reinicia de forma confiável.
 */
export async function supervise(argv: string[]): Promise<number> {
  const script = process.argv[1]!;
  const childArgs = [...process.execArgv, script, ...argv.filter((a) => a !== "--supervise")];
  let attempt = 0;
  let child: ReturnType<typeof spawn> | null = null;
  let quitting = false;
  const forward = (sig: NodeJS.Signals) => {
    quitting = true;
    child?.kill(sig);
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  for (;;) {
    const startedAt = Date.now();
    child = spawn(process.execPath, childArgs, { stdio: "inherit", windowsHide: true });
    const code = await new Promise<number | null>((r) => {
      child!.on("close", (c) => r(c));
      child!.on("error", () => r(null));
    });
    if (quitting) return code ?? 0;
    attempt = Date.now() - startedAt > 60_000 ? 1 : attempt + 1;
    const delay = backoffDelay(attempt, { baseMs: 1000, maxMs: 30_000, jitter: 0.2 });
    console.error(`${new Date().toISOString()} daemon saiu (código ${code}); reiniciando em ${(delay / 1000).toFixed(0)} s`);
    await sleep(delay);
  }
}
