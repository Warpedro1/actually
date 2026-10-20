// Executor da fila kb_jobs: pega a próxima tarefa (lease), roda etapas até o
// orçamento de tempo da invocação e grava o progresso depois de cada uma.
//
// - A etapa em andamento fica em `current` antes de rodar. Se a função morrer no
//   meio, o lease vence e a próxima invocação repete a etapa (são idempotentes);
//   na 3ª queda seguida ela é dada como falha e a fila anda.
// - Erro numa etapa não para a tarefa: conta em steps_failed e segue.
// - Cancelamento (ou lease tomado por outra invocação) aparece como gravação
//   recusada: o executor para na hora, sem sobrescrever nada.
import type { KbLogLine } from "@actually/db";
import type { Ctx, Db } from "../lib/ctx";
import { describeStep, runStep, type KbStep, type StepEnv } from "./steps";

export interface JobRow {
  id: string;
  title: string;
  steps: KbStep[];
  current: KbStep | null;
  current_attempts: number;
  steps_done: number;
  steps_failed: number;
  log: KbLogLine[];
}

export interface JobPatch {
  status?: "done";
  steps?: KbStep[];
  current?: KbStep | null;
  current_attempts?: number;
  steps_done?: number;
  steps_failed?: number;
  log?: KbLogLine[];
  finished_at?: string;
  lease_until: string | null;
}

export interface JobStore {
  /** kb_job_claim: próxima tarefa pendente, ou null (nada pendente ou outra invocação rodando). */
  claim(owner: string, leaseS: number): Promise<JobRow | null>;
  /** Grava se `owner` ainda segura o lease e a tarefa segue rodando; false = cancelada ou lease perdido. */
  save(id: string, owner: string, patch: JobPatch): Promise<boolean>;
}

/** Quedas seguidas na mesma etapa antes de desistir dela. */
export const MAX_ATTEMPTS = 3;
/** Linhas de log guardadas por tarefa. */
export const LOG_LINES = 300;
const MSG_MAX = 500;

export type LogFn = (level: KbLogLine["level"], msg: string) => void;

export interface RunOptions {
  store: JobStore;
  /** Identifica esta invocação no lease. */
  owner: string;
  /** Contexto das etapas com o log da tarefa. */
  makeCtx: (log: LogFn) => Ctx;
  /** Tempo desta invocação para COMEÇAR etapas (a última pode passar um pouco). */
  budgetMs: number;
  /** Validade do lease; maior que a duração máxima da função. */
  leaseS: number;
  now?: () => number;
  stepEnv?: Omit<StepEnv, "deadline" | "now">;
  /** Troca a execução das etapas (testes). */
  runStep?: (ctx: Ctx, step: KbStep, env: StepEnv) => Promise<KbStep[]>;
}

export interface RunResult {
  jobs: number;
  steps: number;
  /** Ainda pode haver trabalho: quem chamou deve encadear outra invocação. */
  more: boolean;
}

/** Contexto padrão das etapas: banco do service role e log na tarefa. */
export function jobCtx(db: Db, log: LogFn): Ctx {
  const fmt = (a: unknown[]) => a.map((x) => (typeof x === "string" ? x : x instanceof Error ? x.message : JSON.stringify(x))).join(" ");
  return { dryRun: false, verbose: false, db, log: (...a) => log("info", fmt(a)), warn: (...a) => log("warn", fmt(a)) };
}

export async function runJobs(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? Date.now;
  const exec = o.runStep ?? runStep;
  const deadline = now() + o.budgetMs;
  const iso = (ms: number) => new Date(ms).toISOString();
  let jobs = 0;
  let steps = 0;

  while (now() < deadline) {
    const job = await o.store.claim(o.owner, o.leaseS);
    if (!job) return { jobs, steps, more: false };
    jobs++;

    const log = [...(job.log ?? [])];
    const push: LogFn = (level, msg) => {
      log.push({ t: iso(now()), level, msg: msg.length > MSG_MAX ? `${msg.slice(0, MSG_MAX)}…` : msg });
      if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
    };
    const ctx = o.makeCtx(push);
    let queue = [...job.steps];
    let current = job.current;
    let attempts = job.current_attempts;
    let done = job.steps_done;
    let failed = job.steps_failed;
    const save = (patch: Omit<JobPatch, "lease_until"> & { lease_until?: string | null }) =>
      o.store.save(job.id, o.owner, { log, lease_until: iso(now() + o.leaseS * 1000), ...patch });

    let outcome: "finished" | "lost" | "budget" | undefined;
    while (!outcome) {
      if (now() >= deadline) {
        // devolve o lease já: a próxima invocação não precisa esperar ele vencer
        outcome = (await save({ steps: queue, lease_until: null })) ? "budget" : "lost";
        break;
      }
      let step: KbStep;
      if (current) {
        attempts++;
        if (attempts > MAX_ATTEMPTS) {
          push("error", `desisti de "${describeStep(current)}": a função caiu ${MAX_ATTEMPTS} vezes nela`);
          failed++;
          current = null;
          attempts = 0;
          if (!(await save({ current: null, current_attempts: 0, steps_failed: failed }))) outcome = "lost";
          continue;
        }
        step = current;
        push("warn", `retomando "${describeStep(step)}" (tentativa ${attempts})`);
      } else {
        const next = queue.shift();
        if (!next) {
          push("info", `concluída: ${done} etapas executadas, ${failed} com falha`);
          outcome = (await save({ status: "done", finished_at: iso(now()), steps: [], current: null, current_attempts: 0, lease_until: null }))
            ? "finished"
            : "lost";
          break;
        }
        step = next;
        attempts = 1;
      }

      if (!(await save({ steps: queue, current: step, current_attempts: attempts }))) {
        outcome = "lost";
        break;
      }
      const t0 = now();
      try {
        const more = await exec(ctx, step, { ...o.stepEnv, deadline, now });
        queue = [...more, ...queue];
        done++;
        push("info", `ok: ${describeStep(step)} (${Math.round((now() - t0) / 1000)} s)${more.length ? " — continua" : ""}`);
      } catch (e) {
        failed++;
        push("error", `falhou: ${describeStep(step)} — ${e instanceof Error ? e.message : String(e)}`);
      }
      steps++;
      current = null;
      attempts = 0;
      if (!(await save({ steps: queue, current: null, current_attempts: 0, steps_done: done, steps_failed: failed }))) outcome = "lost";
    }
    if (outcome === "budget") return { jobs, steps, more: true };
  }
  return { jobs, steps, more: true };
}
