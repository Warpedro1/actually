// Etapas da carga da base pelo /admin (tabela kb_jobs). Cada etapa é curta e
// respeita `deadline`: o que não couber volta como continuação no início da
// fila e roda na próxima invocação. As etapas reaproveitam as funções dos
// comandos da CLI e são idempotentes (upserts), então repetir uma não duplica.
import { lookupSource, tierForUrl, toPgVector, webSearchDomains, type DocType, type IndicatorValue, type KbCounts, type SourceTier } from "@actually/db";
import { abortRun, actorInputProps, datasetPage, inputFromSchema, parseApifyManifest, startActor, waitRun, type ApifyManifest, type YoutubeVideo } from "../apify/client";
import { fillTemplate, filterByDomains, mapSearchItem, mapTranscriptItem } from "../apify/map";
import { crawlInput, crawlItemsToFactchecks, DEFAULT_SEARCH_QUERIES } from "../commands/apify";
import { toDocumentInput } from "../commands/documents";
import { pendingCandidates, processCandidates, writeFactchecks } from "../commands/factchecks";
import { crossCheckUnemployment, loadSeriesValues, withMigrationHint } from "../commands/indicators";
import { resolveCodigo, SENADO_PERSON, speechDocument, speechList, votesDocuments } from "../commands/senado";
import { runTiers } from "../commands/tiers";
import { fetchDocument } from "../documents/fetchDoc";
import { ingestDocument } from "../documents/ingest";
import { collectFeeds } from "../factchecks/feeds";
import { searchGoogle } from "../factchecks/google";
import { isRelevant, type FactcheckCandidate } from "../factchecks/normalize";
import { APIFY_MANIFEST_RAW, FEEDS_RAW } from "../generated/sources";
import { activeSeries, CATALOG, toSeriesRow } from "../indicators/catalog";
import { detectTopics } from "../lib/classify";
import { requireDb, selectAll, upsertRows, type Ctx } from "../lib/ctx";
import { embedDocuments } from "../lib/embed";
import { mapLimit } from "../lib/http";
import { yearWindows } from "../senado/api";

export type ApifyTarget =
  | { type: "crawl"; job: string }
  | { type: "search" }
  | { type: "youtube"; video: YoutubeVideo };

export type KbStep =
  | { kind: "tiers" }
  | { kind: "indicators-series" }
  | { kind: "indicator-values"; code: string; since: string }
  | { kind: "indicators-crosscheck" }
  | { kind: "factchecks-google"; query: string; maxAgeDays?: number; maxPages: number }
  | { kind: "factchecks-feeds"; since?: string }
  | { kind: "factcheck-pages"; origin: string; candidates: FactcheckCandidate[] }
  | { kind: "senado-plan"; since: string; discursos: boolean }
  | { kind: "senado-votes"; codigo: number; from: string; to: string; offset: number }
  | { kind: "senado-speeches"; codigo: number; from: string; to: string; offset: number }
  | { kind: "document"; url: string; title: string; doc_type: DocType; person: string | null; published_at: string | null }
  | { kind: "apify-start"; target: ApifyTarget }
  | { kind: "apify-wait"; target: ApifyTarget; runId: string; datasetId: string; startedAt: string }
  | { kind: "apify-items"; target: ApifyTarget; datasetId: string; offset: number }
  | { kind: "embed-missing"; table: "kb_chunks" | "kb_factchecks" }
  | { kind: "status" };

export interface StepEnv {
  /** Epoch ms. Depois disso a etapa não começa item novo; o resto vira continuação. */
  deadline: number;
  now?: () => number;
  /** Padrão: sources/apify.yaml embutido (src/generated/sources.ts). */
  apify?: ApifyManifest;
  /** Padrão: sources/feeds.yaml embutido. */
  pinnedFeeds?: { name: string; url: string }[];
}

/** Um run do Apify que passa disso é abortado (o teto de custo já limita o gasto). */
export const APIFY_MAX_RUN_MS = 90 * 60_000;
/** Itens do dataset lidos por etapa apify-items. */
export const APIFY_PAGE = 50;
const EMBED_PAGE = 128;

export function defaultApifyManifest(): ApifyManifest {
  return parseApifyManifest(APIFY_MANIFEST_RAW);
}

export function defaultPinnedFeeds(): { name: string; url: string }[] {
  const feeds = (FEEDS_RAW as { feeds?: { name: string; url: string }[] | null } | null)?.feeds ?? [];
  return feeds.filter((f) => f && /^https?:\/\//.test(f.url));
}

function targetLabel(t: ApifyTarget): string {
  if (t.type === "crawl") return `site ${t.job}`;
  if (t.type === "search") return "busca de checagens";
  return `vídeo ${t.video.title ?? t.video.url}`;
}

/** Rótulo curto em português para o log e o painel. */
export function describeStep(s: KbStep): string {
  switch (s.kind) {
    case "tiers":
      return "Fontes confiáveis (níveis 1–4)";
    case "indicators-series":
      return "Catálogo de indicadores";
    case "indicator-values":
      return `Indicador ${s.code}`;
    case "indicators-crosscheck":
      return "Conferência do desemprego (móvel × trimestral)";
    case "factchecks-google":
      return `Google Fact Check: "${s.query}"`;
    case "factchecks-feeds":
      return "Feeds das agências de checagem";
    case "factcheck-pages":
      return `Páginas de checagem (${s.origin}): ${s.candidates.length}`;
    case "senado-plan":
      return "Senado: localizar o senador";
    case "senado-votes":
      return `Senado: votações ${s.from}..${s.to}${s.offset ? ` (a partir da ${s.offset + 1}ª)` : ""}`;
    case "senado-speeches":
      return `Senado: discursos ${s.from}..${s.to}${s.offset ? ` (a partir do ${s.offset + 1}º)` : ""}`;
    case "document":
      return `Documento: ${s.title}`;
    case "apify-start":
      return `Apify: iniciar ${targetLabel(s.target)}`;
    case "apify-wait":
      return `Apify: aguardar ${targetLabel(s.target)}`;
    case "apify-items":
      return `Apify: ler resultados de ${targetLabel(s.target)} (a partir do ${s.offset + 1}º)`;
    case "embed-missing":
      return `Embeddings faltando em ${s.table}`;
    case "status":
      return "Resumo da base";
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/** Executa uma etapa; devolve as continuações (vão para o início da fila). */
export async function runStep(ctx: Ctx, step: KbStep, env: StepEnv): Promise<KbStep[]> {
  const now = env.now ?? Date.now;
  const timeLeft = () => env.deadline - now();
  switch (step.kind) {
    case "tiers":
      await runTiers(ctx);
      return [];

    case "indicators-series": {
      const series = activeSeries().filter((s) => s.fetch.kind !== "none");
      try {
        await upsertRows(ctx, "indicator_series", series.map(toSeriesRow) as unknown as Record<string, unknown>[], "code");
      } catch (e) {
        throw withMigrationHint(e);
      }
      ctx.log(`indicator_series: ${series.length} séries`);
      return [];
    }

    case "indicator-values": {
      const s = CATALOG.find((x) => x.code === step.code);
      if (!s) throw new Error(`série ${step.code} não está no catálogo`);
      const values = await loadSeriesValues(s, step.since, today());
      await upsertRows(ctx, "indicator_values", values as unknown as Record<string, unknown>[], "series_code,period_start");
      const last = values.at(-1);
      ctx.log(`${s.code}: ${values.length} valores${last ? `; último ${last.period_start}..${last.period_end} = ${last.value} ${s.unit}` : ""}`);
      return [];
    }

    case "indicators-crosscheck": {
      const codes = ["desocupacao_pnadc_movel", "desocupacao_pnadc_trimestral"];
      const rows = await selectAll<IndicatorValue>(requireDb(ctx), "indicator_values", "series_code, period_start, period_end, value", (q) =>
        q.in("series_code", codes),
      );
      const loaded = new Map<string, IndicatorValue[]>();
      for (const r of rows) loaded.set(r.series_code, [...(loaded.get(r.series_code) ?? []), r]);
      const mismatches = crossCheckUnemployment(ctx, loaded);
      if (mismatches) throw new Error(`${mismatches} trimestres divergentes entre as séries de desemprego — confira o catálogo`);
      return [];
    }

    case "factchecks-google": {
      const candidates = await searchGoogle({ queries: [step.query], maxAgeDays: step.maxAgeDays, maxPages: step.maxPages, log: ctx.log });
      return candidates.length ? [{ kind: "factcheck-pages", origin: `Google "${step.query}"`, candidates }] : [];
    }

    case "factchecks-feeds": {
      const { candidates } = await collectFeeds({ pinned: env.pinnedFeeds ?? defaultPinnedFeeds(), since: step.since, log: ctx.log, warn: ctx.warn });
      return candidates.length ? [{ kind: "factcheck-pages", origin: "feeds", candidates }] : [];
    }

    case "factcheck-pages": {
      const todo = await pendingCandidates(ctx, step.candidates);
      if (!todo.length) return [];
      const { rest } = await processCandidates(ctx, todo, { deadline: env.deadline });
      if (rest.length) ctx.log(`${rest.length} páginas ficam para a próxima rodada`);
      return rest.length ? [{ ...step, candidates: rest }] : [];
    }

    case "senado-plan": {
      const codigo = await resolveCodigo(ctx, SENADO_PERSON);
      const out: KbStep[] = [];
      for (const [from, to] of yearWindows(step.since, today())) {
        out.push({ kind: "senado-votes", codigo, from, to, offset: 0 });
        if (step.discursos) out.push({ kind: "senado-speeches", codigo, from, to, offset: 0 });
      }
      return out;
    }

    case "senado-votes": {
      const { votes, docs } = await votesDocuments(step.codigo, step.from, step.to);
      if (step.offset === 0) ctx.log(`votações ${step.from}..${step.to}: ${votes} (${docs.length} viram documento)`);
      const next = await ingestUntil(ctx, docs.slice(step.offset), timeLeft);
      return step.offset + next < docs.length ? [{ ...step, offset: step.offset + next }] : [];
    }

    case "senado-speeches": {
      const list = await speechList(step.codigo, step.from, step.to);
      if (step.offset === 0) ctx.log(`discursos ${step.from}..${step.to}: ${list.length}`);
      let i = step.offset;
      for (; i < list.length && timeLeft() > 0; i++) {
        try {
          const doc = await speechDocument(list[i]!);
          if (doc) await ingestDocument(ctx, doc);
        } catch (e) {
          ctx.warn(`discurso ${list[i]!.codigo}: ${(e as Error).message}`);
        }
      }
      return i < list.length ? [{ ...step, offset: i }] : [];
    }

    case "document": {
      const fetched = await fetchDocument(step.url);
      const doc = toDocumentInput(
        { url: step.url, title: step.title, doc_type: step.doc_type, person: step.person, published_at: step.published_at ?? fetched.publishedAt },
        fetched.text,
      );
      const r = await ingestDocument(ctx, doc);
      ctx.log(`${r === "skipped" ? "sem mudança" : "gravado"}: ${step.url} (${fetched.format}, ${fetched.text.length} caracteres)`);
      return [];
    }

    case "apify-start": {
      const m = env.apify ?? defaultApifyManifest();
      const { actor, input, maxItems } = await apifyRequest(m, step.target);
      const { runId, datasetId } = await startActor(actor, input, { maxItems, log: ctx.log });
      return [{ kind: "apify-wait", target: step.target, runId, datasetId, startedAt: new Date(now()).toISOString() }];
    }

    case "apify-wait": {
      const status = await waitRun(step.runId, Math.min(60, timeLeft() / 1000));
      if (status === "SUCCEEDED") return [{ kind: "apify-items", target: step.target, datasetId: step.datasetId, offset: 0 }];
      if (status === "READY" || status === "RUNNING") {
        if (now() - Date.parse(step.startedAt) > APIFY_MAX_RUN_MS) {
          await abortRun(step.runId);
          throw new Error(`run ${step.runId} passou de ${APIFY_MAX_RUN_MS / 60_000} min e foi abortado`);
        }
        ctx.log(`run ${step.runId}: ${status}`);
        return [step];
      }
      throw new Error(`run ${step.runId} terminou com status ${status}`);
    }

    case "apify-items": {
      const items = await datasetPage(step.datasetId, step.offset, APIFY_PAGE);
      const more: KbStep[] = items.length === APIFY_PAGE ? [{ ...step, offset: step.offset + APIFY_PAGE }] : [];
      return [...(await ingestApifyItems(ctx, env.apify ?? defaultApifyManifest(), step.target, items)), ...more];
    }

    case "embed-missing": {
      const db = requireDb(ctx);
      const text = step.table === "kb_chunks" ? "text" : "claim_text";
      let done = 0;
      while (timeLeft() > 0) {
        const { data, error } = await db.from(step.table).select(`id, ${text}`).is("embedding", null).order("id").limit(EMBED_PAGE);
        if (error) throw new Error(`${step.table}: ${error.message}`);
        const rows = (data ?? []) as unknown as Record<string, string | number>[];
        if (!rows.length) {
          ctx.log(`${step.table}: ${done} embeddings preenchidos; nenhum faltando`);
          return [];
        }
        const vectors = await embedDocuments(rows.map((r) => String(r[text])), ctx.log);
        await mapLimit(rows, 4, async (r, i) => {
          const { error: e } = await db.from(step.table).update({ embedding: toPgVector(vectors[i]!) }).eq("id", r.id!);
          if (e) throw new Error(`${step.table} ${r.id}: ${e.message}`);
        });
        done += rows.length;
      }
      ctx.log(`${step.table}: ${done} embeddings preenchidos; continua na próxima rodada`);
      return [step];
    }

    case "status": {
      const c = await kbCounts(ctx);
      ctx.log(
        `base: ${c.kb_factchecks} checagens (${c.kb_factchecks_sem_embedding} sem embedding), ` +
          `${c.indicator_series} séries / ${c.indicator_values} valores, ` +
          `${c.kb_documents} documentos / ${c.kb_chunks} trechos (${c.kb_chunks_sem_embedding} sem embedding), ` +
          `${c.source_tiers} fontes com nível`,
      );
      return [];
    }
  }
}

/** Ingere documentos em ordem até acabar o tempo; devolve quantos foram tentados. */
async function ingestUntil(ctx: Ctx, docs: Parameters<typeof ingestDocument>[1][], timeLeft: () => number): Promise<number> {
  let i = 0;
  for (; i < docs.length && timeLeft() > 0; i++) {
    try {
      await ingestDocument(ctx, docs[i]!);
    } catch (e) {
      ctx.warn((e as Error).message);
    }
  }
  return i;
}

export async function kbCounts(ctx: Pick<Ctx, "db">): Promise<KbCounts> {
  const db = requireDb(ctx as Ctx);
  const { data, error } = await db.rpc("kb_counts");
  if (error) throw new Error(`kb_counts: ${error.message}`);
  return data as KbCounts;
}

/** Actor, input e teto de itens do run para o alvo (mesma montagem dos comandos apify-*). */
export async function apifyRequest(m: ApifyManifest, t: ApifyTarget): Promise<{ actor: string; input: unknown; maxItems?: number }> {
  if (t.type === "crawl") {
    if (!m.crawl?.input) throw new Error("defina crawl.input em sources/apify.yaml");
    const job = (m.crawl.jobs ?? []).find((j) => j.name === t.job);
    if (!job) throw new Error(`job ${t.job} não está em sources/apify.yaml`);
    return { actor: m.crawl.actor, input: crawlInput(m.crawl.input, job), maxItems: job.max_pages };
  }
  if (t.type === "search") {
    if (!m.search?.input) throw new Error("defina search.input em sources/apify.yaml");
    const queries = m.search.queries?.length ? m.search.queries : DEFAULT_SEARCH_QUERIES;
    return { actor: m.search.actor, input: fillTemplate(m.search.input, { $QUERIES_NEWLINE: queries.join("\n"), $QUERIES: queries }) };
  }
  if (!m.youtube) throw new Error("sources/apify.yaml sem bloco youtube");
  const urls = [t.video.url];
  if (m.youtube.input) {
    return { actor: m.youtube.actor, input: fillTemplate(m.youtube.input, { $URLS: urls, $START_URLS: urls.map((url) => ({ url })) }), maxItems: 2 };
  }
  const props = await actorInputProps(m.youtube.actor);
  if (!props) throw new Error(`o Actor ${m.youtube.actor} não publica schema de input; defina youtube.input em sources/apify.yaml`);
  return { actor: m.youtube.actor, input: inputFromSchema(props, urls), maxItems: 2 };
}

/** Itens de um dataset → base. Busca vira páginas de checagem (continuação). */
async function ingestApifyItems(ctx: Ctx, m: ApifyManifest, t: ApifyTarget, items: Record<string, unknown>[]): Promise<KbStep[]> {
  if (!items.length) return [];
  if (t.type === "crawl") {
    const job = (m.crawl?.jobs ?? []).find((j) => j.name === t.job);
    if (!job) throw new Error(`job ${t.job} não está em sources/apify.yaml`);
    const { rows, reasons } = crawlItemsToFactchecks(items, job);
    const kept = rows.filter(isRelevant);
    ctx.log(`${items.length} páginas: ${kept.length} checagens no tema (descartes: ${JSON.stringify({ ...reasons, fora_do_tema: rows.length - kept.length })})`);
    await writeFactchecks(ctx, kept);
    return [];
  }
  if (t.type === "search") {
    const results = filterByDomains(items.flatMap(mapSearchItem), webSearchDomains(2));
    const checks = results.filter((r) => lookupSource(r.url)?.kind === "checagem");
    ctx.log(`${results.length} resultados em fontes de nível 1–2; ${checks.length} em agências de checagem`);
    return checks.length ? [{ kind: "factcheck-pages", origin: "busca Apify", candidates: checks.map((r) => ({ url: r.url })) }] : [];
  }
  const v = t.video;
  let ok = 0;
  for (const it of items) {
    const tr = mapTranscriptItem(it, v.url);
    if (!tr) continue;
    await ingestDocument(ctx, {
      url: v.url,
      title: v.title ?? tr.title ?? v.url,
      doc_type: v.doc_type,
      person: v.person ?? null,
      source_name: "YouTube (legenda/transcrição via Apify)",
      // legenda automática pode errar: youtube.com é nível 4 e nunca sustenta alerta sozinho
      tier: tierForUrl(v.url) as SourceTier,
      published_at: v.published_at ? new Date(v.published_at).toISOString() : null,
      topics: detectTopics(tr.text.slice(0, 20_000)).slice(0, 5),
      body: tr.text,
    });
    ok++;
    break; // um vídeo por run: a primeira transcrição reconhecível basta
  }
  if (!ok) throw new Error(`nenhuma transcrição reconhecível nos ${items.length} itens do Actor`);
  ctx.log(`transcrição gravada: ${v.url}`);
  return [];
}
