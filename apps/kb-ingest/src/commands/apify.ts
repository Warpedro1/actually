// Coletores via Apify (manifesto sources/apify.yaml):
//   apify-check   --actor <id>                         confirma nome, preço e schema de input do Actor
//   apify-crawl   [--only <job>] [--dataset <id> | --items arquivo.json]
//   apify-youtube [--dataset <id> | --items arquivo.json]
//   apify-search  [--dataset <id> | --items arquivo.json]
// --dataset reaproveita um dataset já pago; --items processa um export local (sem custo).
// Em --dry-run sem --items/--dataset, só imprime o input que seria enviado.
import { lookupSource, tierForUrl, webSearchDomains, type DocType, type SourceTier } from "@actually/db";
import type { Ctx } from "../lib/ctx";
import { detectTopics } from "../lib/classify";
import { ingestDocument } from "../documents/ingest";
import { buildFactcheckRow, isRelevant, type FactcheckCandidate, type FactcheckRow } from "../factchecks/normalize";
import { GOOGLE_QUERIES } from "../factchecks/google";
import { ingestCandidates, writeFactchecks } from "./factchecks";
import { apifyClient, datasetItems, itemsFromFile, loadApifyManifest, runActor, type CrawlJob } from "../apify/client";
import { fillTemplate, filterByDomains, mapCrawlItem, mapSearchItem, mapTranscriptItem } from "../apify/map";

export interface ApifyOpts {
  manifest: string;
  only?: string;
  dataset?: string;
  items?: string;
  actor?: string;
  allTopics?: boolean;
  skipEmbed?: boolean;
  limit?: number;
}

type Items = Record<string, unknown>[];

async function obtainItems(
  ctx: Ctx,
  opts: ApifyOpts,
  actor: string,
  input: unknown,
  maxItems?: number,
): Promise<Items | null> {
  if (opts.items) return itemsFromFile(opts.items);
  if (opts.dataset) return datasetItems(opts.dataset);
  if (ctx.dryRun) {
    ctx.log(`[dry-run] chamaria ${actor} com input:\n${JSON.stringify(input, null, 2)}`);
    return null;
  }
  return (await runActor(actor, input, { maxItems, log: ctx.log })).items;
}

// --------------------------------------------------------------------------- check
export async function runApifyCheck(ctx: Ctx, opts: ApifyOpts): Promise<void> {
  if (!opts.actor) throw new Error("informe --actor <usuario/nome>");
  const client = apifyClient();
  const actor = await client.actor(opts.actor).get();
  if (!actor) throw new Error(`Actor ${opts.actor} não existe (ou não é visível para este token)`);
  ctx.log(`${actor.username}/${actor.name} — ${actor.title ?? ""}`);
  ctx.log(`  deprecated: ${actor.isDeprecated ?? false}`);
  const pricing = actor.pricingInfos?.at(-1);
  ctx.log(`  preço: ${pricing ? JSON.stringify(pricing) : "(sem pricingInfos — cobra só uso da plataforma)"}`);
  const build = await (await client.actor(opts.actor).defaultBuild()).get();
  const schema = build?.actorDefinition?.input ?? (build?.inputSchema ? JSON.parse(build.inputSchema) : null);
  const props = (schema as { properties?: Record<string, { type?: string; title?: string; default?: unknown }> } | null)?.properties;
  if (!props) {
    ctx.log("  schema de input: não registrado (veja o README do Actor)");
    return;
  }
  ctx.log("  campos de input:");
  for (const [k, v] of Object.entries(props)) {
    ctx.log(`    ${k.padEnd(28)} ${String(v.type ?? "").padEnd(8)} ${v.title ?? ""}${v.default !== undefined ? ` (padrão ${JSON.stringify(v.default)})` : ""}`);
  }
}

// --------------------------------------------------------------------------- crawl
export function crawlInput(template: Record<string, unknown>, job: CrawlJob): unknown {
  const filled = fillTemplate(template, {
    $START_URLS: job.start_urls.map((url) => ({ url })),
    $URLS: job.start_urls,
    $MAX_PAGES: job.max_pages,
  }) as Record<string, unknown>;
  return { ...filled, ...(job.input_extra ?? {}) };
}

/** Itens do crawler → linhas L1 (checagens com rating detectável). Pura. */
export function crawlItemsToFactchecks(items: Items, job: CrawlJob): { rows: FactcheckRow[]; reasons: Record<string, number> } {
  const rows: FactcheckRow[] = [];
  const reasons: Record<string, number> = {};
  for (const it of items) {
    const page = mapCrawlItem(it);
    if (!page) {
      reasons.item_invalido = (reasons.item_invalido ?? 0) + 1;
      continue;
    }
    const cand: FactcheckCandidate = { url: page.url, sourceName: job.source_name ?? null, title: page.title, publishedAt: page.publishedAt };
    const r = buildFactcheckRow(cand, { title: page.title, text: page.text, publishedAt: page.publishedAt, claimReviews: [] });
    if (r.ok) rows.push(r.row);
    else reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  }
  return { rows, reasons };
}

export async function runApifyCrawl(ctx: Ctx, opts: ApifyOpts): Promise<void> {
  const m = loadApifyManifest(opts.manifest);
  if (!m.crawl) throw new Error("manifesto sem bloco crawl");
  if (!m.crawl.input) throw new Error("defina crawl.input no manifesto (confirme os campos com apify-check)");
  let jobs = (m.crawl.jobs ?? []).filter((j) => j.enabled);
  if (opts.only) jobs = jobs.filter((j) => j.name === opts.only);
  if (!jobs.length) throw new Error("nenhum job habilitado (ou --only não casou)");
  if ((opts.dataset || opts.items) && jobs.length > 1) throw new Error("--dataset/--items exigem --only <job>");

  for (const job of jobs) {
    ctx.log(`job ${job.name} (${job.kind})`);
    const items = await obtainItems(ctx, opts, m.crawl.actor, crawlInput(m.crawl.input, job), job.max_pages);
    if (!items) continue;
    ctx.log(`  ${items.length} páginas recebidas`);
    if (job.kind === "factcheck") {
      const { rows, reasons } = crawlItemsToFactchecks(items, job);
      const kept = opts.allTopics ? rows : rows.filter(isRelevant);
      ctx.log(`  checagens: ${kept.length} (descartes: ${JSON.stringify({ ...reasons, fora_do_tema: rows.length - kept.length })})`);
      await writeFactchecks(ctx, opts.limit ? kept.slice(0, opts.limit) : kept, opts.skipEmbed);
    } else {
      let n = 0;
      for (const it of items) {
        const page = mapCrawlItem(it);
        if (!page || page.text.length < 500) continue;
        if (opts.limit && n >= opts.limit) break;
        try {
          await ingestDocument(
            ctx,
            {
              url: page.url,
              title: page.title ?? page.url,
              doc_type: job.doc_type as DocType,
              person: job.person ?? null,
              source_name: job.source_name ?? lookupSource(page.url)?.name ?? new URL(page.url).hostname,
              tier: tierForUrl(page.url) as SourceTier,
              published_at: page.publishedAt,
              topics: job.topics?.length ? job.topics : detectTopics(page.title, page.text.slice(0, 5000)).slice(0, 3),
              body: page.text,
            },
            { skipEmbed: opts.skipEmbed },
          );
          n++;
        } catch (e) {
          ctx.warn((e as Error).message);
        }
      }
      ctx.log(`  documentos: ${n}`);
    }
  }
}

// --------------------------------------------------------------------------- youtube
/** ID do vídeo (watch?v=, youtu.be/, /live/, /shorts/, /embed/). */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1).split("/")[0] || null;
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    const m = /^\/(?:live|shorts|embed)\/([^/?#]+)/.exec(u.pathname);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export async function runApifyYoutube(ctx: Ctx, opts: ApifyOpts): Promise<void> {
  const m = loadApifyManifest(opts.manifest);
  if (!m.youtube) throw new Error("manifesto sem bloco youtube");
  const videos = m.youtube.videos ?? [];
  if (!videos.length) {
    ctx.log("nenhum vídeo em youtube.videos (adicione as URLs confirmadas ao manifesto)");
    return;
  }
  if (!m.youtube.input) {
    throw new Error("defina youtube.input no manifesto — o schema do Actor de transcrição não foi confirmado; rode apify-check --actor " + m.youtube.actor);
  }
  const input = fillTemplate(m.youtube.input, { $URLS: videos.map((v) => v.url), $START_URLS: videos.map((v) => ({ url: v.url })) });
  const items = await obtainItems(ctx, opts, m.youtube.actor, input, videos.length * 2);
  if (!items) return;
  const byId = new Map(videos.map((v) => [youtubeId(v.url) ?? v.url, v]));
  let ok = 0;
  for (const it of items) {
    const t = mapTranscriptItem(it, videos.length === 1 ? videos[0]!.url : undefined);
    const v = t ? byId.get(youtubeId(t.url) ?? t.url) : undefined;
    if (!t || !v) {
      ctx.warn(`item sem transcrição reconhecível ou sem vídeo correspondente: ${JSON.stringify(it).slice(0, 160)}`);
      continue;
    }
    await ingestDocument(
      ctx,
      {
        url: v.url,
        title: v.title ?? t.title ?? v.url,
        doc_type: v.doc_type,
        person: v.person ?? null,
        source_name: "YouTube (legenda/transcrição via Apify)",
        // legenda automática pode errar: tier 4 nunca sustenta alerta sozinho
        tier: tierForUrl(v.url) as SourceTier,
        published_at: v.published_at ? new Date(v.published_at).toISOString() : null,
        topics: detectTopics(t.text.slice(0, 20_000)).slice(0, 5),
        body: t.text,
      },
      { skipEmbed: opts.skipEmbed },
    );
    ok++;
  }
  ctx.log(`transcrições ingeridas: ${ok}/${videos.length}`);
}

// --------------------------------------------------------------------------- search
export const DEFAULT_SEARCH_QUERIES = [
  "checagem Lula",
  "checagem Flávio Bolsonaro",
  "é falso Lula",
  "é falso Flávio Bolsonaro",
  ...GOOGLE_QUERIES.slice(5).map((t) => `checagem ${t}`),
];

export async function runApifySearch(ctx: Ctx, opts: ApifyOpts): Promise<void> {
  const m = loadApifyManifest(opts.manifest);
  if (!m.search) throw new Error("manifesto sem bloco search");
  if (!m.search.input) throw new Error("defina search.input no manifesto (confirme os campos com apify-check)");
  const queries = m.search.queries?.length ? m.search.queries : DEFAULT_SEARCH_QUERIES;
  const input = fillTemplate(m.search.input, { $QUERIES_NEWLINE: queries.join("\n"), $QUERIES: queries });
  const items = await obtainItems(ctx, opts, m.search.actor, input);
  if (!items) return;
  const results = filterByDomains(items.flatMap(mapSearchItem), webSearchDomains(2));
  const checks = results.filter((r) => lookupSource(r.url)?.kind === "checagem");
  ctx.log(`resultados em domínios tier 1–2: ${results.length}; em agências de checagem: ${checks.length}`);
  if (ctx.verbose) {
    for (const r of results.filter((x) => !checks.includes(x))) ctx.log(`  (não-checagem) ${r.url}`);
  }
  await ingestCandidates(
    ctx,
    // título do buscador costuma vir truncado/com sufixo do site: deixa a página decidir
    checks.map((r) => ({ url: r.url })),
    { allTopics: opts.allTopics, limit: opts.limit, skipEmbed: opts.skipEmbed },
  );
}
