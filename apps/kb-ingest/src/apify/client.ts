// Cliente Apify (apify-client): roda um Actor, espera e lê o dataset padrão.
// Guarda de custo: maxTotalChargeUsd (APIFY_MAX_CHARGE_USD, padrão 5) em toda execução.
import { readFileSync } from "node:fs";
import { ApifyClient } from "apify-client";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export function apifyClient(): ApifyClient {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN ausente");
  return new ApifyClient({ token });
}

export const MAX_CHARGE_USD = Number(process.env.APIFY_MAX_CHARGE_USD ?? 5);

export async function runActor(
  actorId: string,
  input: unknown,
  opts: { maxItems?: number; log: (...a: unknown[]) => void },
): Promise<{ runId: string; datasetId: string; items: Record<string, unknown>[] }> {
  const client = apifyClient();
  opts.log(`apify: iniciando ${actorId} (teto de custo US$ ${MAX_CHARGE_USD})`);
  const run = await client.actor(actorId).call(input, {
    maxItems: opts.maxItems,
    maxTotalChargeUsd: MAX_CHARGE_USD,
    waitSecs: 60 * 60,
  });
  opts.log(`apify: run ${run.id} terminou com status ${run.status} (dataset ${run.defaultDatasetId})`);
  if (run.status !== "SUCCEEDED") throw new Error(`run ${run.id} terminou com status ${run.status}`);
  const items = await datasetItems(run.defaultDatasetId);
  return { runId: run.id, datasetId: run.defaultDatasetId, items };
}

export async function datasetItems(datasetId: string): Promise<Record<string, unknown>[]> {
  const client = apifyClient();
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await client.dataset(datasetId).listItems({ offset, limit: 1000, clean: true });
    out.push(...(page.items as Record<string, unknown>[]));
    if (page.items.length < 1000) break;
  }
  return out;
}

/** Itens salvos localmente (export JSON de um dataset) — permite reprocessar sem custo. */
export function itemsFromFile(path: string): Record<string, unknown>[] {
  const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(j)) throw new Error(`${path}: esperado um array JSON de itens`);
  return j as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Manifesto sources/apify.yaml
// ---------------------------------------------------------------------------
const DocType = z.enum(["programa", "entrevista", "discurso", "debate", "lei", "votacao", "noticia", "dado", "outro"]);

export const CrawlJob = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** factcheck ⇒ L1 (exige rating no texto); document ⇒ L3. */
  kind: z.enum(["factcheck", "document"]),
  start_urls: z.array(z.string().regex(/^https?:\/\//)).min(1),
  max_pages: z.number().int().positive().default(100),
  doc_type: DocType.default("outro"),
  person: z.string().nullish(),
  source_name: z.string().nullish(),
  topics: z.array(z.string()).nullish(),
  /** Campos extras mesclados no input do Actor (ex.: padrões de inclusão), após confirmação. */
  input_extra: z.record(z.string(), z.unknown()).nullish(),
});
export type CrawlJob = z.infer<typeof CrawlJob>;

export const YoutubeVideo = z.object({
  url: z.string().regex(/^https?:\/\//),
  doc_type: z.enum(["debate", "entrevista", "discurso"]),
  person: z.string().nullish(),
  title: z.string().nullish(),
  published_at: z.string().nullish(),
});
export type YoutubeVideo = z.infer<typeof YoutubeVideo>;

const ActorBlock = z.object({
  actor: z.string().min(3),
  /** Input do Actor com marcadores ($START_URLS, $URLS, $QUERIES_NEWLINE, $QUERIES, $MAX_PAGES). */
  input: z.record(z.string(), z.unknown()).nullish(),
});

export const ApifyManifest = z.object({
  crawl: ActorBlock.extend({ jobs: z.array(CrawlJob).nullish() }).nullish(),
  youtube: ActorBlock.extend({ videos: z.array(YoutubeVideo).nullish() }).nullish(),
  search: ActorBlock.extend({
    queries: z.array(z.string()).nullish(),
    max_results_per_query: z.number().int().positive().nullish(),
  }).nullish(),
});
export type ApifyManifest = z.infer<typeof ApifyManifest>;

export function loadApifyManifest(path: string): ApifyManifest {
  const parsed = ApifyManifest.safeParse(parseYaml(readFileSync(path, "utf8")) ?? {});
  if (!parsed.success) throw new Error(`manifesto Apify inválido (${path}): ${parsed.error.message}`);
  return parsed.data;
}
