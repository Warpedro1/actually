// CLI do kb-ingest: `pnpm --filter @actually/kb-ingest start -- <comando> [opções]`.
// Todos os comandos são idempotentes (upserts) e aceitam --dry-run (não grava nada).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { makeCtx } from "./lib/ctx";
import { runTiers } from "./commands/tiers";
import { runIndicators } from "./commands/indicators";
import { runFactchecks } from "./commands/factchecks";
import { runDocuments } from "./commands/documents";
import { runSenado } from "./commands/senado";
import { runTranscribe } from "./commands/transcribe";
import { runEmbedMissing } from "./commands/embedMissing";
import { runStatus } from "./commands/status";
import { runApifyCheck, runApifyCrawl, runApifySearch, runApifyYoutube } from "./commands/apify";

const APP_DIR = resolve(import.meta.dirname, "..");
const path = (p: string) => resolve(APP_DIR, p);

const HELP = `kb-ingest — cargas da base de conhecimento

comandos:
  tiers                         SOURCE_TIERS → source_tiers
  factchecks                    L1: Google Fact Check Tools + feeds das agências
      [--source google|feeds|all] [--since AAAA-MM-DD] [--max-pages N] [--query "..."]...
      [--verify-feeds] [--all-topics] [--refresh] [--limit N]
  indicators                    L2: séries oficiais (BCB SGS, IBGE SIDRA)
      [--list] [--check] [--only a,b] [--since AAAA-MM-DD] [--include-pending]
  documents                     L3: manifesto sources/documents.yaml ou arquivo local
      [--manifest arq.yaml] [--only trecho-da-url] [--force]
      [--file transcricao.txt|.json --meta '{"url":..,"title":..,"doc_type":..}' [--speakers "0=Nome"]]
  senado                        votações (e --discursos) de Flávio Bolsonaro no Senado
      [--codigo N] [--nome "..."] [--since AAAA-MM-DD] [--until AAAA-MM-DD] [--discursos] [--limit N]
  transcribe                    Deepgram pré-gravado → data/transcripts/*.json|txt
      (--file audio | --url URL) [--out dir] [--speakers "0=Nome,1=Nome"]
      [--ingest --doc-type debate|entrevista --person ".." --title ".." --source-url URL --published-at AAAA-MM-DD]
  embed-missing                 preenche embeddings nulos (Voyage) [--table kb_chunks|kb_factchecks|all] [--max N]
  status                        contagens por tabela/fonte/pessoa/tópico/série
  apify-check --actor ID        confirma Actor, preço e campos de input
  apify-crawl                   website-content-crawler (sources/apify.yaml) [--only job]
  apify-youtube                 transcrições do YouTube via Actor (sources/apify.yaml)
  apify-search                  descoberta de checagens via Google Search Scraper
      (apify-*: [--manifest arq.yaml] [--dataset ID | --items export.json] [--all-topics] [--limit N])

globais: --dry-run  --verbose  --skip-embed  --help`;

async function main() {
  // `pnpm start -- cmd` pode repassar o "--" literal; sem isso tudo viraria posicional
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      "dry-run": { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      "skip-embed": { type: "boolean" },
      limit: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      only: { type: "string" },
      // factchecks
      source: { type: "string" },
      "max-pages": { type: "string" },
      query: { type: "string", multiple: true },
      "verify-feeds": { type: "boolean" },
      "all-topics": { type: "boolean" },
      refresh: { type: "boolean" },
      // indicators
      list: { type: "boolean" },
      check: { type: "boolean" },
      "include-pending": { type: "boolean" },
      // documents / apify
      manifest: { type: "string" },
      file: { type: "string" },
      meta: { type: "string" },
      speakers: { type: "string" },
      force: { type: "boolean" },
      dataset: { type: "string" },
      items: { type: "string" },
      actor: { type: "string" },
      // senado
      codigo: { type: "string" },
      nome: { type: "string" },
      discursos: { type: "boolean" },
      // transcribe
      url: { type: "string" },
      out: { type: "string" },
      ingest: { type: "boolean" },
      "doc-type": { type: "string" },
      person: { type: "string" },
      title: { type: "string" },
      "source-url": { type: "string" },
      "published-at": { type: "string" },
      // embed-missing
      table: { type: "string" },
      max: { type: "string" },
    },
  });
  const cmd = positionals[0];
  if (!cmd || v.help) {
    console.log(HELP);
    return;
  }
  const int = (s: string | undefined) => (s === undefined ? undefined : Number.parseInt(s, 10));
  const ctx = makeCtx({ dryRun: Boolean(v["dry-run"]), verbose: Boolean(v.verbose) });
  const skipEmbed = Boolean(v["skip-embed"]);
  const apifyOpts = {
    manifest: v.manifest ?? path("sources/apify.yaml"),
    only: v.only,
    dataset: v.dataset,
    items: v.items,
    actor: v.actor,
    allTopics: v["all-topics"],
    skipEmbed,
    limit: int(v.limit),
  };

  switch (cmd) {
    case "tiers":
      return runTiers(ctx);
    case "factchecks":
      return runFactchecks(ctx, {
        source: (v.source as "google" | "feeds" | "all" | undefined) ?? "all",
        since: v.since,
        maxPages: int(v["max-pages"]),
        queries: v.query,
        verifyFeeds: v["verify-feeds"],
        allTopics: v["all-topics"],
        refresh: v.refresh,
        limit: int(v.limit),
        skipEmbed,
        feedsPath: path("sources/feeds.yaml"),
      });
    case "indicators":
      return runIndicators(ctx, {
        list: v.list,
        check: v.check,
        only: v.only?.split(",").map((s) => s.trim()).filter(Boolean),
        since: v.since,
        includePending: v["include-pending"],
      });
    case "documents":
      return runDocuments(ctx, {
        manifest: v.manifest ?? path("sources/documents.yaml"),
        only: v.only,
        file: v.file,
        meta: v.meta,
        speakers: v.speakers,
        force: v.force,
        skipEmbed,
      });
    case "senado":
      return runSenado(ctx, {
        codigo: int(v.codigo),
        nome: v.nome,
        since: v.since,
        until: v.until,
        discursos: v.discursos,
        skipEmbed,
        limit: int(v.limit),
      });
    case "transcribe":
      return runTranscribe(ctx, {
        file: v.file,
        url: v.url,
        out: v.out ?? path("data/transcripts"),
        speakers: v.speakers,
        ingest: v.ingest,
        docType: v["doc-type"] as "debate" | "entrevista" | undefined,
        person: v.person,
        title: v.title,
        sourceUrl: v["source-url"],
        publishedAt: v["published-at"],
        skipEmbed,
      });
    case "embed-missing":
      return runEmbedMissing(ctx, { table: v.table as "kb_chunks" | "kb_factchecks" | "all" | undefined, max: int(v.max) });
    case "status":
      return runStatus(ctx);
    case "apify-check":
      return runApifyCheck(ctx, apifyOpts);
    case "apify-crawl":
      return runApifyCrawl(ctx, apifyOpts);
    case "apify-youtube":
      return runApifyYoutube(ctx, apifyOpts);
    case "apify-search":
      return runApifySearch(ctx, apifyOpts);
    default:
      console.error(`comando desconhecido: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((e: unknown) => {
  console.error(`erro: ${(e as Error).message}`);
  if (process.env.DEBUG) console.error(e);
  process.exitCode = 1;
});
