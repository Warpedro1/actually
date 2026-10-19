// transcribe: transcrição em lote (Deepgram pré-gravado) de arquivo local ou URL.
//   --file audio.mp3 | --url https://...  (YouTube: baixa o áudio com yt-dlp -x, se instalado)
//   --out data/transcripts               (padrão)
//   --speakers "0=Lula,1=..."           nomes no .txt (só depois de conferir quem é quem)
//   --ingest --doc-type debate|entrevista --person "..." --title "..." --source-url https://... --published-at 2026-10-22
// Saída: <out>/<nome>.json (formato Transcript) e <out>/<nome>.txt ("[mm:ss] Falante N: ...").
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { lookupSource, tierForUrl, type SourceTier } from "@actually/db";
import type { Ctx } from "../lib/ctx";
import { detectTopics } from "../lib/classify";
import { fetchJson } from "../lib/http";
import { ingestDocument } from "../documents/ingest";
import { fromDeepgram, parseSpeakerMap, transcriptToText } from "../transcribe/format";

export const DEEPGRAM_URL =
  "https://api.deepgram.com/v1/listen?model=nova-3&language=pt-BR&diarize=true&smart_format=true&utterances=true";

export interface TranscribeOpts {
  file?: string;
  url?: string;
  out: string;
  speakers?: string;
  ingest?: boolean;
  docType?: "debate" | "entrevista";
  person?: string;
  title?: string;
  sourceUrl?: string;
  publishedAt?: string;
  skipEmbed?: boolean;
}

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

export function isYoutube(url: string): boolean {
  return /^https?:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .toLowerCase();
}

/** Baixa só o áudio com yt-dlp (precisa estar no PATH, junto com ffmpeg). */
function downloadAudio(url: string, dir: string): string {
  const probe = spawnSync("yt-dlp", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    throw new Error("yt-dlp não encontrado no PATH. Instale (pip install yt-dlp) ou use `apify-youtube` para pegar a legenda.");
  }
  mkdirSync(dir, { recursive: true });
  const before = new Set(readdirSync(dir));
  const r = spawnSync("yt-dlp", ["-x", "--audio-format", "mp3", "--no-playlist", "-o", join(dir, "%(id)s.%(ext)s"), url], {
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`yt-dlp falhou (código ${r.status})`);
  const created = readdirSync(dir).filter((f) => !before.has(f) && f.endsWith(".mp3"));
  if (!created[0]) throw new Error("yt-dlp não produziu o .mp3 esperado");
  return join(dir, created[0]);
}

export async function runTranscribe(ctx: Ctx, opts: TranscribeOpts): Promise<void> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!opts.file && !opts.url) throw new Error("informe --file ou --url");
  if (opts.ingest && !opts.docType) throw new Error("--ingest exige --doc-type debate|entrevista");
  const publicUrl = opts.sourceUrl ?? opts.url;
  if (opts.ingest && (!publicUrl || !/^https?:\/\//.test(publicUrl))) {
    throw new Error("--ingest exige uma URL pública (--source-url) para kb_documents.url");
  }

  let file = opts.file ? resolve(opts.file) : undefined;
  let body: { kind: "file"; path: string } | { kind: "url"; url: string };
  if (opts.url && isYoutube(opts.url)) {
    if (ctx.dryRun) {
      ctx.log(`[dry-run] baixaria o áudio de ${opts.url} com yt-dlp -x para data/raw/`);
      body = { kind: "url", url: opts.url };
    } else {
      file = downloadAudio(opts.url, resolve("data/raw"));
      body = { kind: "file", path: file };
    }
  } else if (opts.url) {
    body = { kind: "url", url: opts.url };
  } else {
    if (!existsSync(file!)) throw new Error(`arquivo não encontrado: ${file}`);
    body = { kind: "file", path: file! };
  }

  const name = slug(opts.title ?? (file ? basename(file, extname(file)) : new URL(opts.url!).pathname + new URL(opts.url!).search)) || "transcricao";
  const outDir = resolve(opts.out);
  if (ctx.dryRun) {
    ctx.log(`[dry-run] POST ${DEEPGRAM_URL} (${body.kind === "file" ? body.path : body.url})`);
    ctx.log(`[dry-run] gravaria ${join(outDir, name)}.json e .txt${opts.ingest ? ` e ingeriria como ${opts.docType} (${publicUrl})` : ""}`);
    return;
  }
  if (!key) throw new Error("DEEPGRAM_API_KEY ausente");

  ctx.log(`transcrevendo ${body.kind === "file" ? body.path : body.url} …`);
  const json = await fetchJson(DEEPGRAM_URL, {
    method: "POST",
    headers:
      body.kind === "file"
        ? { Authorization: `Token ${key}`, "Content-Type": MIME[extname(body.path).toLowerCase()] ?? "application/octet-stream" }
        : { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: body.kind === "file" ? new Uint8Array(readFileSync(body.path)) : JSON.stringify({ url: body.url }),
    timeoutMs: 30 * 60_000, // pré-gravado de 2 h pode levar minutos
    retries: 2,
  });
  const transcript = fromDeepgram(json, publicUrl ?? file ?? "");
  const text = transcriptToText(transcript, parseSpeakerMap(opts.speakers));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(transcript, null, 2));
  writeFileSync(join(outDir, `${name}.txt`), text + "\n");
  ctx.log(`ok: ${transcript.utterances.length} falas, ${transcript.duration_s ?? "?"} s → ${join(outDir, name)}.{json,txt}`);

  if (opts.ingest) {
    const r = await ingestDocument(
      ctx,
      {
        url: publicUrl!,
        title: opts.title ?? name,
        doc_type: opts.docType!,
        person: opts.person ?? null,
        source_name: lookupSource(publicUrl!)?.name ?? new URL(publicUrl!).hostname,
        tier: tierForUrl(publicUrl!) as SourceTier,
        published_at: opts.publishedAt ? new Date(opts.publishedAt).toISOString() : null,
        topics: detectTopics(text.slice(0, 20_000)).slice(0, 5),
        body: text,
      },
      { skipEmbed: opts.skipEmbed },
    );
    ctx.log(`documento: ${r}`);
  }
}
