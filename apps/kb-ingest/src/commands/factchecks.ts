// factchecks (L1): Google Fact Check Tools + feeds das agências → kb_factchecks.
//   --source google|feeds|all   (padrão all)
//   --since 2026-01-01          só checagens a partir dessa data
//   --max-pages 3               páginas por consulta no Google (100 por página)
//   --query "x" (repetível)     consultas extras no Google
//   --verify-feeds              só descobre/lista os feeds das agências e sai
//   --all-topics                não filtra por pessoa/tópico-guia
//   --refresh                   reprocessa URLs que já estão no banco
//   --limit N                   no máximo N páginas baixadas
import { toPgVector } from "@actually/db";
import { selectAll, upsertRows, type Ctx } from "../lib/ctx";
import { embedDocuments, hasEmbeddingKey } from "../lib/embed";
import { extractPage } from "../lib/html";
import { fetchText, mapLimit } from "../lib/http";
import { collectFeeds, agencies, discoverFeedLinks } from "../factchecks/feeds";
import { GOOGLE_QUERIES, searchGoogle } from "../factchecks/google";
import { buildFactcheckRow, canonicalUrl, isRelevant, type FactcheckCandidate, type FactcheckRow, type PageContent } from "../factchecks/normalize";

export interface FactchecksOpts {
  source?: "google" | "feeds" | "all";
  since?: string;
  maxPages?: number;
  queries?: string[];
  verifyFeeds?: boolean;
  allTopics?: boolean;
  refresh?: boolean;
  limit?: number;
  skipEmbed?: boolean;
  feedsPath: string;
}

export async function runFactchecks(ctx: Ctx, opts: FactchecksOpts): Promise<void> {
  if (opts.verifyFeeds) return verifyFeeds(ctx);
  const source = opts.source ?? "all";
  const candidates: FactcheckCandidate[] = [];
  if (source === "google" || source === "all") {
    if (!process.env.GOOGLE_FACTCHECK_API_KEY) {
      ctx.warn("GOOGLE_FACTCHECK_API_KEY ausente — pulando a Fact Check Tools API");
    } else {
      const maxAgeDays = opts.since ? Math.max(1, Math.ceil((Date.now() - Date.parse(opts.since)) / 86_400_000)) : undefined;
      ctx.log("Google Fact Check Tools:");
      candidates.push(
        ...(await searchGoogle({ queries: [...GOOGLE_QUERIES, ...(opts.queries ?? [])], maxAgeDays, maxPages: opts.maxPages ?? 3, log: ctx.log })),
      );
    }
  }
  if (source === "feeds" || source === "all") {
    ctx.log("Feeds das agências:");
    const { candidates: c } = await collectFeeds({ pinnedPath: opts.feedsPath, since: opts.since, log: ctx.log, warn: ctx.warn });
    candidates.push(...c);
  }
  await ingestCandidates(ctx, candidates, opts);
}

/** Baixa as páginas, normaliza, filtra e grava. Reutilizado por apify-search. */
export async function ingestCandidates(
  ctx: Ctx,
  candidates: FactcheckCandidate[],
  opts: { allTopics?: boolean; refresh?: boolean; limit?: number; skipEmbed?: boolean },
): Promise<void> {
  // dedup por URL canônica; o primeiro candidato (Google tem mais metadados) vence
  const byUrl = new Map<string, FactcheckCandidate>();
  for (const c of candidates) {
    const key = canonicalUrl(c.url);
    if (!byUrl.has(key)) byUrl.set(key, { ...c, url: key });
  }
  let todo = [...byUrl.values()];
  if (ctx.db && !opts.refresh) {
    const existing = new Set((await selectAll<{ url: string }>(ctx.db, "kb_factchecks", "url")).map((r) => r.url));
    const before = todo.length;
    todo = todo.filter((c) => !existing.has(c.url));
    ctx.log(`${before - todo.length} já estão no banco (use --refresh para reprocessar)`);
  }
  if (opts.limit) todo = todo.slice(0, opts.limit);
  ctx.log(`${todo.length} páginas para baixar`);

  const reasons: Record<string, number> = {};
  const count = (r: string) => (reasons[r] = (reasons[r] ?? 0) + 1);
  const rows: FactcheckRow[] = [];
  await mapLimit(todo, 3, async (c) => {
    let page: PageContent;
    try {
      page = extractPage(await fetchText(c.url, { respectRobots: true }), c.url);
    } catch (e) {
      count("download_falhou");
      if (ctx.verbose) ctx.warn(`${c.url}: ${(e as Error).message}`);
      return;
    }
    const r = buildFactcheckRow(c, page);
    if (!r.ok) {
      count(r.reason);
      if (ctx.verbose) ctx.log(`  descartado (${r.reason}): ${c.url}`);
      return;
    }
    if (!opts.allTopics && !isRelevant(r.row)) {
      count("fora_do_tema");
      return;
    }
    rows.push(r.row);
  });
  ctx.log(`checagens aproveitadas: ${rows.length}; descartes: ${JSON.stringify(reasons)}`);
  await writeFactchecks(ctx, rows, opts.skipEmbed);
}

export async function writeFactchecks(ctx: Ctx, rows: FactcheckRow[], skipEmbed?: boolean): Promise<void> {
  if (!rows.length) return;
  let embeddings: (string | null)[] = rows.map(() => null);
  if (!skipEmbed && hasEmbeddingKey() && !ctx.dryRun) {
    embeddings = (await embedDocuments(rows.map((r) => r.claim_text), ctx.log)).map(toPgVector);
  } else if (!hasEmbeddingKey()) {
    ctx.log("VOYAGE_API_KEY ausente — embeddings ficam nulos (rode embed-missing depois)");
  }
  const byVerdict: Record<string, number> = {};
  for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  ctx.log(`vereditos: ${JSON.stringify(byVerdict)}`);
  await upsertRows(
    ctx,
    "kb_factchecks",
    rows.map((r, i) => ({ ...r, ...(embeddings[i] ? { embedding: embeddings[i] } : {}) })),
    "url",
    { batch: 100 },
  );
}

async function verifyFeeds(ctx: Ctx): Promise<void> {
  ctx.log("Descoberta de feeds (link rel=alternate na página inicial de cada agência):");
  for (const a of agencies()) {
    try {
      const links = discoverFeedLinks(await fetchText(a.home, { respectRobots: true }), a.home);
      ctx.log(`  ${a.name.padEnd(22)} ${a.home}\n     ${links.length ? links.join("\n     ") : "(nenhum feed anunciado)"}`);
    } catch (e) {
      ctx.log(`  ${a.name.padEnd(22)} ${a.home}\n     ERRO: ${(e as Error).message}`);
    }
  }
  ctx.log("Para fixar um feed conferido, adicione-o a sources/feeds.yaml.");
}
