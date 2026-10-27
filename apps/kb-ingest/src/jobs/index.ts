// API do kb-ingest para o painel de carga do /admin (rotas /api/kb/* na Vercel).
export { planJob, PlanError, type Plan } from "./presets";
export { describeStep, kbCounts, type KbStep, type ReplayStep, type StepEnv } from "./steps";
export { jobCtx, runJobs, type JobPatch, type JobRow, type JobStore, type LogFn, type RunResult } from "./runner";
