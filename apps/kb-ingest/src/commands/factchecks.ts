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
import { ingestDocument } from "../documents/ingest";
import { upsertRows, type Ctx, type Db } from "../lib/ctx";
import { embedDocuments, hasEmbeddingKey } from "../lib/embed";
import { extractPage } from "../lib/html";
import { fetchText, mapUntil, RobotsDisallowedError } from "../lib/http";
import { canFallBackToTavily, hasTavilyKey, tavilyExtract } from "../lib/tavily";
import { collectFeeds, agencies, discoverFeedLinks } from "../factchecks/feeds";
import { GOOGLE_QUERIES, searchGoogle } from "../factchecks/google";
import {
  agencyStoryDocument,
  buildFactcheckRow,
  canonicalUrl,
  isRelevant,
  pageFromText,
  type FactcheckCandidate,
  type FactcheckRow,
  type PageContent,
} from "../factchecks/normalize";

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
  let todo = await pendingCandidates(ctx, candidates, opts);
  if (opts.limit) todo = todo.slice(0, opts.limit);
  ctx.log(`${todo.length} páginas para baixar`);
  await processCandidates(ctx, todo, opts);
}

/** URLs por consulta `in` (a lista vai na query string do PostgREST). */
const URL_BATCH = 50;

/** Quais destas URLs já estão na base (kb_factchecks ou kb_documents). */
export async function urlsInBase(db: Db, urls: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const uniq = [...new Set(urls)];
  for (const table of ["kb_factchecks", "kb_documents"]) {
    for (let i = 0; i < uniq.length; i += URL_BATCH) {
      const { data, error } = await db.from(table).select("url").in("url", uniq.slice(i, i + URL_BATCH));
      if (error) throw new Error(`select ${table}: ${error.message}`);
      for (const r of (data ?? []) as { url: string }[]) out.add(r.url);
    }
  }
  return out;
}

/**
 * Dedup por URL canônica e (sem `refresh`) tira as que já estão na base — como checagem
 * ou como documento (matéria de agência com várias falas não é baixada de novo todo dia).
 */
export async function pendingCandidates(
  ctx: Ctx,
  candidates: FactcheckCandidate[],
  opts: { refresh?: boolean } = {},
): Promise<FactcheckCandidate[]> {
  // o primeiro candidato (Google tem mais metadados) vence
  const byUrl = new Map<string, FactcheckCandidate>();
  for (const c of candidates) {
    const key = canonicalUrl(c.url);
    if (!byUrl.has(key)) byUrl.set(key, { ...c, url: key });
  }
  let todo = [...byUrl.values()];
  if (ctx.db && !opts.refresh && todo.length) {
    const existing = await urlsInBase(ctx.db, todo.map((c) => c.url));
    const before = todo.length;
    todo = todo.filter((c) => !existing.has(c.url));
    ctx.log(`${before - todo.length} já estão no banco (use --refresh para reprocessar)`);
  }
  return todo;
}

/** Recusas de buildFactcheckRow que, em página de agência, indicam matéria com várias falas. */
const STORY_REASONS = new Set(["sem_rating", "sem_afirmacao", "sem_trecho"]);

/**
 * Baixa, normaliza, filtra e grava. Com `deadline` (epoch ms) não começa página
 * nova depois do prazo e devolve as que ficaram para a próxima rodada.
 * - candidato com `page` (busca da Tavily) não é baixado de novo;
 * - download recusado por HTTP/rede é lido pela Tavily (robots.txt proibindo, não);
 * - matéria de agência com várias falas (sem selo único) vira documento L3.
 */
export async function processCandidates(
  ctx: Ctx,
  todo: FactcheckCandidate[],
  opts: { allTopics?: boolean; skipEmbed?: boolean; deadline?: number },
): Promise<{ rest: FactcheckCandidate[] }> {
  const reasons: Record<string, number> = {};
  const count = (r: string) => (reasons[r] = (reasons[r] ?? 0) + 1);
  const rows: FactcheckRow[] = [];
  let viaTavily = 0;
  // falhas da Tavily: uma linha no fim, não uma por página
  let tavilyFailures = 0;
  let firstTavilyFailure = "";
  const tavilyWarn = (...a: unknown[]) => {
    tavilyFailures++;
    firstTavilyFailure ||= a.map(String).join(" ");
  };

  async function download(c: FactcheckCandidate): Promise<PageContent | null> {
    try {
      return extractPage(await fetchText(c.url, { respectRobots: true }), c.url);
    } catch (e) {
      if (ctx.verbose) ctx.warn(`${c.url}: ${(e as Error).message}`);
      if (e instanceof RobotsDisallowedError) {
        count("robots_txt");
        return null;
      }
      if (!canFallBackToTavily(e) || !hasTavilyKey()) {
        count("download_falhou");
        return null;
      }
      const got = await tavilyExtract(c.url, { warn: tavilyWarn });
      if (!got) {
        count("download_falhou");
        return null;
      }
      viaTavily++;
      return pageFromText({ url: c.url, title: got.title, text: got.text, publishedAt: c.publishedAt });
    }
  }

  /** Matéria de agência → documento L3, sem sobrescrever documento que já existe. */
  async function storyAsDocument(c: FactcheckCandidate, page: PageContent): Promise<boolean> {
    const doc = agencyStoryDocument(c, page);
    if (!doc) return false;
    try {
      if (ctx.db) {
        // documento com a mesma URL pode ter sido curado à mão
        const { data, error } = await ctx.db.from("kb_documents").select("id").eq("url", doc.url).maybeSingle();
        if (error) throw new Error(`kb_documents: ${error.message}`);
        if (data) {
          count("ja_na_base");
          return true;
        }
      }
      await ingestDocument(ctx, doc, { skipEmbed: opts.skipEmbed });
      count("virou_documento");
    } catch (e) {
      count("erro_documento");
      ctx.warn(`${c.url}: ${(e as Error).message}`);
    }
    return true;
  }

  const { rest } = await mapUntil(todo, 3, opts.deadline, async (c) => {
    const page = c.page ?? (await download(c));
    if (!page) return;
    const r = buildFactcheckRow(c, page);
    if (!r.ok) {
      if (STORY_REASONS.has(r.reason) && (await storyAsDocument(c, page))) return;
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
  ctx.log(
    `checagens aproveitadas: ${rows.length}; descartes: ${JSON.stringify(reasons)}` +
      (viaTavily ? `; ${viaTavily} páginas lidas pela Tavily (download direto recusado)` : ""),
  );
  if (tavilyFailures) ctx.warn(`Tavily não leu ${tavilyFailures} páginas (a primeira: ${firstTavilyFailure})`);
  await writeFactchecks(ctx, rows, opts.skipEmbed);
  return { rest };
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
