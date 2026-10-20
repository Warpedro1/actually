// Pedido do painel (KbJobCreate) → fila de etapas. Confere as chaves do
// ambiente antes: o que não pode rodar sai da fila com um aviso (ou recusa o
// pedido inteiro, quando nada dele rodaria).
import type { KbJobCreate } from "@actually/db";
import { GOOGLE_QUERIES } from "../factchecks/google";
import { activeSeries } from "../indicators/catalog";
import { SENADO_SINCE } from "../commands/senado";
import { defaultApifyManifest, type KbStep } from "./steps";

/** Início padrão das checagens na carga completa. */
export const DEFAULT_FACTCHECKS_SINCE = "2025-01-01";
/** Início das séries (cobre Lula 1 em diante), igual à CLI. */
export const INDICATORS_SINCE = "2003-01-01";
/** Janela da atualização diária (com folga para checagens publicadas com atraso). */
export const DAILY_DAYS = 3;
const GOOGLE_MAX_PAGES = 3;

export class PlanError extends Error {}

export interface Plan {
  title: string;
  steps: KbStep[];
  /** Avisos que vão para o início do log da tarefa. */
  notes: string[];
}

type Env = Record<string, string | undefined>;

function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(1, Math.ceil((Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000));
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

function indicatorSteps(): KbStep[] {
  return [
    { kind: "indicators-series" },
    ...activeSeries()
      .filter((s) => s.fetch.kind !== "none")
      .map((s): KbStep => ({ kind: "indicator-values", code: s.code, since: INDICATORS_SINCE })),
    { kind: "indicators-crosscheck" },
  ];
}

function factcheckSteps(since: string | undefined, source: "google" | "feeds" | "all", today: string, env: Env, notes: string[]): KbStep[] {
  const out: KbStep[] = [];
  if (source !== "feeds") {
    if (env.GOOGLE_FACTCHECK_API_KEY) {
      const maxAgeDays = since ? daysBetween(since, today) : undefined;
      for (const query of GOOGLE_QUERIES) out.push({ kind: "factchecks-google", query, maxAgeDays, maxPages: GOOGLE_MAX_PAGES });
    } else {
      notes.push("GOOGLE_FACTCHECK_API_KEY não está na Vercel: a busca no Google Fact Check foi pulada (só feeds).");
    }
  }
  if (source !== "google") out.push({ kind: "factchecks-feeds", since });
  return out;
}

function embedSteps(env: Env, notes: string[]): KbStep[] {
  if (!env.VOYAGE_API_KEY) {
    notes.push("VOYAGE_API_KEY não está na Vercel: o que entrar fica sem embedding (a busca por sentido não acha).");
    return [];
  }
  return [
    { kind: "embed-missing", table: "kb_factchecks" },
    { kind: "embed-missing", table: "kb_chunks" },
  ];
}

function requireApify(env: Env): void {
  if (!env.APIFY_TOKEN) throw new PlanError("APIFY_TOKEN não está configurado na Vercel");
}

export function planJob(req: KbJobCreate, opts: { today: string; env: Env }): Plan {
  const { today, env } = opts;
  const notes: string[] = [];
  const status: KbStep = { kind: "status" };
  switch (req.preset) {
    case "carga-completa": {
      const since = req.since ?? DEFAULT_FACTCHECKS_SINCE;
      return {
        title: `Carga completa (checagens desde ${since})`,
        steps: [
          { kind: "tiers" },
          ...indicatorSteps(),
          ...factcheckSteps(since, "all", today, env, notes),
          { kind: "senado-plan", since: SENADO_SINCE, discursos: false },
          ...embedSteps(env, notes),
          status,
        ],
        notes,
      };
    }
    case "fontes":
      return { title: "Fontes confiáveis", steps: [{ kind: "tiers" }], notes };
    case "indicadores":
      return { title: "Indicadores oficiais (BCB e IBGE)", steps: [...indicatorSteps(), status], notes };
    case "checagens": {
      const steps = factcheckSteps(req.since, req.source, today, env, notes);
      if (!steps.length) throw new PlanError("GOOGLE_FACTCHECK_API_KEY não está configurado na Vercel");
      return {
        title: `Checagens${req.since ? ` desde ${req.since}` : ""} (${req.source === "all" ? "Google + feeds" : req.source})`,
        steps: [...steps, ...embedSteps(env, notes), status],
        notes,
      };
    }
    case "senado":
      return {
        title: `Senado: votações${req.discursos ? " e discursos" : ""} de Flávio Bolsonaro`,
        steps: [{ kind: "senado-plan", since: req.since ?? SENADO_SINCE, discursos: req.discursos }, ...embedSteps(env, notes), status],
        notes,
      };
    case "documento":
      return {
        title: `Documento: ${req.title}`,
        steps: [
          {
            kind: "document",
            url: req.url,
            title: req.title,
            doc_type: req.doc_type,
            person: req.person ?? null,
            published_at: req.published_at ?? null,
          },
          ...embedSteps(env, notes),
          status,
        ],
        notes,
      };
    case "youtube":
      requireApify(env);
      return {
        title: `Vídeo do YouTube: ${req.title ?? req.url}`,
        steps: [
          {
            kind: "apify-start",
            target: {
              type: "youtube",
              video: { url: req.url, doc_type: req.doc_type, person: req.person ?? null, title: req.title ?? null, published_at: req.published_at ?? null },
            },
          },
          ...embedSteps(env, notes),
          status,
        ],
        notes,
      };
    case "apify-agencias": {
      requireApify(env);
      let jobs = (defaultApifyManifest().crawl?.jobs ?? []).filter((j) => j.enabled);
      if (req.job) jobs = jobs.filter((j) => j.name === req.job);
      if (!jobs.length) throw new PlanError(req.job ? `job ${req.job} não está habilitado em sources/apify.yaml` : "nenhum job habilitado em sources/apify.yaml");
      return {
        title: `Sites das agências via Apify (${jobs.map((j) => j.name).join(", ")})`,
        steps: [...jobs.map((j): KbStep => ({ kind: "apify-start", target: { type: "crawl", job: j.name } })), ...embedSteps(env, notes), status],
        notes,
      };
    }
    case "apify-busca":
      requireApify(env);
      return {
        title: "Busca de checagens via Apify",
        steps: [{ kind: "apify-start", target: { type: "search" } }, ...embedSteps(env, notes), status],
        notes,
      };
    case "embeddings": {
      const steps = embedSteps(env, notes);
      if (!steps.length) throw new PlanError("VOYAGE_API_KEY não está configurado na Vercel");
      return { title: "Embeddings faltando", steps: [...steps, status], notes };
    }
    case "atualizacao-diaria": {
      const since = addDays(today, -DAILY_DAYS);
      return {
        title: `Atualização diária (checagens desde ${since} + indicadores)`,
        steps: [...factcheckSteps(since, "all", today, env, notes), ...indicatorSteps(), ...embedSteps(env, notes), status],
        notes,
      };
    }
  }
}
