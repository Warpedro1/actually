import "server-only";
import { randomUUID } from "node:crypto";
import type { KbJob, KbJobCreate } from "@actually/db";
import { describeStep, jobCtx, planJob, runJobs, type JobPatch, type JobRow, type JobStore, type KbStep, type RunResult } from "@actually/kb-ingest/jobs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "./db";
import { tokensMatch } from "./ingestAuth";

/** Duração máxima das rotas /api/kb/* (Vercel, plano Hobby com fluid compute). */
export const KB_MAX_DURATION_S = 300;
/** Tempo para COMEÇAR etapas; a última pode passar (fetch com retry), por isso a folga até 300 s. */
export const KB_BUDGET_MS = 170_000;
/** Lease maior que a duração máxima: se a função morrer, vence logo depois. */
export const KB_LEASE_S = 330;

/** Chaves que a carga usa; o painel mostra quais faltam (nunca os valores). */
export const KB_ENV_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "VOYAGE_API_KEY",
  "GOOGLE_FACTCHECK_API_KEY",
  "APIFY_TOKEN",
  "TAVILY_API_KEY",
  "CRON_SECRET",
] as const;

export function kbEnv(): Record<(typeof KB_ENV_KEYS)[number], boolean> {
  return Object.fromEntries(KB_ENV_KEYS.map((k) => [k, Boolean(process.env[k])])) as Record<(typeof KB_ENV_KEYS)[number], boolean>;
}

export function supabaseJobStore(db: SupabaseClient): JobStore {
  return {
    async claim(owner, leaseS) {
      const { data, error } = await db.rpc("kb_job_claim", { p_owner: owner, p_lease_s: leaseS });
      if (error) throw new Error(`kb_job_claim: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as (JobRow & Record<string, unknown>) | undefined;
      return row ?? null;
    },
    async save(id, owner, patch: JobPatch) {
      const { data, error } = await db
        .from("kb_jobs")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("lease_owner", owner)
        .eq("status", "running")
        .select("id");
      if (error) throw new Error(`kb_jobs: ${error.message}`);
      return (data ?? []).length === 1;
    },
  };
}

/** A rota interna de continuação aceita só o CRON_SECRET (o mesmo que a Vercel manda no cron). */
export function checkCronSecret(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return Boolean(expected && m && tokensMatch(m[1], expected));
}

/** Pede outra invocação para continuar (cada função tem tempo limitado). */
export async function chainRun(origin: string): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[kb] CRON_SECRET ausente: a carga só continua quando o painel estiver aberto ou no próximo pedido");
    return;
  }
  try {
    const r = await fetch(`${origin}/api/kb/run`, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    if (!r.ok) console.error(`[kb] encadeamento recusado: HTTP ${r.status}`);
  } catch (e) {
    console.error("[kb] encadeamento falhou:", e);
  }
}

/** Roda a fila até o orçamento e, se sobrar trabalho, encadeia outra invocação. Nunca lança. */
export async function runKb(origin: string): Promise<RunResult | null> {
  try {
    const db = getServiceClient();
    const r = await runJobs({
      store: supabaseJobStore(db),
      owner: randomUUID(),
      makeCtx: (log) => jobCtx(db, log),
      budgetMs: KB_BUDGET_MS,
      leaseS: KB_LEASE_S,
    });
    if (r.more) await chainRun(origin);
    return r;
  } catch (e) {
    console.error("[kb] executor falhou:", e);
    return null;
  }
}

/** Há tarefa pendente sem ninguém rodando (lease vazio ou vencido)? */
export function needsRunner(jobs: Pick<KbJob, "status" | "lease_until">[], now = Date.now()): boolean {
  return jobs.some(
    (j) => (j.status === "queued" || j.status === "running") && (!j.lease_until || Date.parse(j.lease_until) < now),
  );
}

/** Rótulo da etapa em andamento para o painel (o cliente não importa o kb-ingest). */
export function stepLabel(step: unknown): string | null {
  if (!step || typeof step !== "object" || !("kind" in step)) return null;
  try {
    return describeStep(step as KbStep);
  } catch {
    return String((step as { kind: unknown }).kind);
  }
}

/** Pedido do painel (ou do cron) → linha em kb_jobs com a fila de etapas. Lança PlanError se não puder rodar. */
export async function createJob(
  db: SupabaseClient,
  req: KbJobCreate,
  createdBy: string | null,
  now = new Date(),
  via = createdBy ? "no /admin" : "pelo cron diário",
): Promise<{ id: string; title: string; notes: string[] }> {
  const plan = planJob(req, { today: now.toISOString().slice(0, 10), env: process.env });
  const t = now.toISOString();
  const log = [
    { t, level: "info", msg: `pedida ${via}: ${plan.steps.length} etapas` },
    ...plan.notes.map((msg) => ({ t, level: "warn", msg })),
  ];
  const { data, error } = await db
    .from("kb_jobs")
    .insert({ preset: req.preset, title: plan.title, params: req, steps: plan.steps, log, created_by: createdBy })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`kb_jobs: ${error?.message ?? "sem id"}`);
  return { id: data.id, title: plan.title, notes: plan.notes };
}

/**
 * Depois de um trecho que gravou páginas na fila da web (kb_web_finds): garante uma
 * tarefa "capturas-web" e pede um executor se ninguém estiver rodando. Duas chamadas
 * ao mesmo tempo podem criar duas tarefas — inofensivo: a RPC da fila nunca entrega a
 * mesma página duas vezes. Se houver tarefa de OUTRO tipo pendente (ex.: carga completa
 * que parou), só enfileira: o executor pega a mais antiga de qualquer tipo, e a checagem
 * ao vivo não pode acordar uma carga pesada no meio do debate. Nunca lança.
 */
export async function kickWebFinds(db: SupabaseClient, origin: string): Promise<void> {
  try {
    const { data, error } = await db
      .from("kb_jobs")
      .select("preset, status, lease_until")
      .in("status", ["queued", "running"])
      .limit(50);
    if (error) throw new Error(`kb_jobs: ${error.message}`);
    const pending = (data ?? []) as Pick<KbJob, "preset" | "status" | "lease_until">[];
    const mine = pending.filter((j) => j.preset === "capturas-web");
    const others = pending.length > mine.length;
    if (!mine.length) await createJob(db, { preset: "capturas-web" }, null, new Date(), "pela checagem ao vivo");
    else if (!needsRunner(mine)) return;
    if (others) return;
    await chainRun(origin);
  } catch (e) {
    console.error("[kb] fila da web:", e);
  }
}
