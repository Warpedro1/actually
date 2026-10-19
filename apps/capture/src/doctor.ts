// `capture doctor` — checagem antes do debate: dependências, variáveis, API,
// e opcionalmente se o yt-dlp resolve a live e se o dispositivo tem som.

import { randomUUID } from "node:crypto";
import { ApiError, IngestClient } from "./api";
import {
  buildProbeArgs,
  buildYtDlpArgs,
  ffmpegBin,
  levelDbfs,
  listDevicesCommands,
  peakDbfs,
  ytDlpBin,
} from "./audio";
import { apiUrlConflict, envFileValues } from "./env";
import { runCmd } from "./proc";

type Level = "ok" | "aviso" | "FALHA";

/**
 * Valida o INGEST_TOKEN de verdade, sem efeito colateral: heartbeat de um
 * agent_id aleatório. A rota checa o token, depois a configuração do Supabase
 * (service role) e chama capture_heartbeat, que não acha o agente e não grava
 * nada ⇒ 404 "agente desconhecido" significa que token, servidor e banco
 * responderam. GET /api/health é público e não serve para isso.
 */
export async function probeIngestToken(
  client: Pick<IngestClient, "heartbeat">,
  agentId: string = randomUUID(),
): Promise<{ level: Level; detail: string }> {
  try {
    await client.heartbeat({ agent_id: agentId });
    return { level: "ok", detail: "aceito pela API" };
  } catch (err) {
    const e = err instanceof ApiError ? err : new ApiError(String(err), null, true);
    if (e.status === 404 && /agente desconhecido/.test(e.message)) {
      return { level: "ok", detail: "aceito pela API (token, Supabase e banco respondendo)" };
    }
    if (e.status === 401 || e.status === 403) {
      return {
        level: "FALHA",
        detail: `recusado pela API (HTTP ${e.status}) — o token de ~/.actually/capture.env tem de ser igual ao INGEST_TOKEN da Vercel`,
      };
    }
    if (e.status === 503) {
      return {
        level: "FALHA",
        detail: `API sem configuração (HTTP 503) — confira INGEST_TOKEN e SUPABASE_SERVICE_ROLE_KEY na Vercel: ${e.message}`,
      };
    }
    if (e.status === 404) {
      return { level: "FALHA", detail: `rota de ingestão não encontrada (HTTP 404) — a URL da API é a do site? ${e.message}` };
    }
    if (e.status === null) return { level: "FALHA", detail: `não deu para validar: ${e.message}` };
    return { level: "FALHA", detail: `não deu para validar (HTTP ${e.status}): ${e.message}` };
  }
}

export interface DoctorOptions {
  api: string | null;
  url: string | null;
  device: string | null;
  ytdlpFormat: string;
}

export async function doctor(o: DoctorOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let failures = 0;
  const report = (level: Level, what: string, detail = "") => {
    if (level === "FALHA") failures++;
    const tag = level === "ok" ? "[ ok  ]" : level === "aviso" ? "[aviso]" : "[FALHA]";
    console.log(`${tag} ${what}${detail ? ` — ${detail}` : ""}`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  report(major >= 22 ? "ok" : "FALHA", "node", `v${process.versions.node}${major >= 22 ? "" : " (precisa ≥ 22)"}`);

  const ff = await runCmd(ffmpegBin(env), ["-hide_banner", "-version"], 10_000);
  if (ff.error || ff.code !== 0) report("FALHA", "ffmpeg", ff.error ?? `saiu com código ${ff.code}`);
  else report("ok", "ffmpeg", ff.stdout.toString().split("\n")[0]?.trim() ?? "");

  const yt = await runCmd(ytDlpBin(env), ["--version"], 10_000);
  if (yt.error || yt.code !== 0) report(o.url ? "FALHA" : "aviso", "yt-dlp", `${yt.error ?? `código ${yt.code}`} (necessário só para --source youtube)`);
  else report("ok", "yt-dlp", yt.stdout.toString().trim());

  const dgKey = env.DEEPGRAM_API_KEY;
  if (!dgKey) report("FALHA", "DEEPGRAM_API_KEY", "ausente");
  else {
    try {
      const res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${dgKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) report("ok", "DEEPGRAM_API_KEY", "chave aceita");
      else if (res.status === 401 || res.status === 403) report("FALHA", "DEEPGRAM_API_KEY", `recusada (HTTP ${res.status})`);
      else report("aviso", "DEEPGRAM_API_KEY", `HTTP ${res.status} ao validar`);
    } catch (err) {
      report("aviso", "DEEPGRAM_API_KEY", `presente, mas não deu para validar (${(err as Error).message})`);
    }
  }

  if (!o.api) report("FALHA", "API", "sem --api nem ACTUALLY_API_URL");
  else {
    try {
      const status = await new IngestClient({ baseUrl: o.api, token: env.INGEST_TOKEN ?? "" }).health();
      if (status >= 200 && status < 300) report("ok", "API", `${o.api}/api/health → ${status}`);
      else if (status === 404) report("aviso", "API", `${o.api} responde, mas /api/health não existe (404)`);
      else report("FALHA", "API", `${o.api}/api/health → HTTP ${status}`);
    } catch (err) {
      report("FALHA", "API", `${o.api} inacessível (${(err as Error).message})`);
    }
  }

  const apiConflict = apiUrlConflict(envFileValues("ACTUALLY_API_URL"));
  if (apiConflict) report("aviso", "ACTUALLY_API_URL", `${apiConflict} — o daemon usa a primeira; \`run\` sem --api recusa`);

  if (!env.INGEST_TOKEN) report("FALHA", "INGEST_TOKEN", "ausente");
  else if (!o.api) report("aviso", "INGEST_TOKEN", "presente, mas não validado (sem API)");
  else {
    const r = await probeIngestToken(new IngestClient({ baseUrl: o.api, token: env.INGEST_TOKEN, timeoutMs: 10_000 }));
    report(r.level, "INGEST_TOKEN", r.detail);
  }

  if (o.url) {
    // --print implica simulação: resolve formato/URL sem baixar
    const args = buildYtDlpArgs(o.url, o.ytdlpFormat).filter((a) => a !== "-o" && a !== "-");
    const r = await runCmd(ytDlpBin(env), [...args, "--print", "%(title)s", "--print", "%(live_status)s", "--print", "%(format_id)s"], 60_000);
    if (r.error || r.code !== 0) report("FALHA", "yt-dlp resolve a URL", (r.error ?? r.stderr.trim().split("\n").slice(-2).join(" ")) || `código ${r.code}`);
    else {
      const [title, live, fmt] = r.stdout.toString().trim().split("\n");
      report("ok", "yt-dlp resolve a URL", `“${title}” (${live}, formato ${fmt})`);
      if (live && live !== "is_live") report("aviso", "live", `live_status=${live} — ainda não está ao vivo?`);
    }
  }

  if (o.device) {
    const r = await runCmd(ffmpegBin(env), buildProbeArgs(o.device, process.platform, 3), 20_000);
    if (r.error || r.stdout.length === 0) {
      report("FALHA", `dispositivo ${o.device}`, r.error ?? (r.stderr.trim().split("\n").pop() || "sem áudio"));
    } else {
      const rms = levelDbfs(r.stdout);
      const peak = peakDbfs(r.stdout);
      const detail = `3 s gravados: RMS ${rms.toFixed(1)} dBFS, pico ${peak.toFixed(1)} dBFS`;
      if (peak < -50) report("FALHA", `dispositivo ${o.device}`, `${detail} — silêncio; o áudio está tocando? é o dispositivo certo?`);
      else if (peak > -0.5) report("aviso", `dispositivo ${o.device}`, `${detail} — clipando; baixe o volume`);
      else report("ok", `dispositivo ${o.device}`, detail);
    }
  }

  console.log(failures === 0 ? "\ntudo certo." : `\n${failures} falha(s).`);
  return failures === 0 ? 0 : 1;
}

export async function listDevices(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let any = false;
  for (const { cmd, args } of listDevicesCommands(process.platform, ffmpegBin(env))) {
    const r = await runCmd(cmd, args, 15_000);
    if (r.error) {
      console.log(`(${cmd} indisponível: ${r.error})`);
      continue;
    }
    // ffmpeg lista no stderr e sai com erro (não há entrada de verdade)
    const text = `${r.stdout.toString()}${r.stderr}`.trim();
    if (text) {
      any = true;
      console.log(`$ ${cmd} ${args.join(" ")}\n${text}\n`);
    }
  }
  if (process.platform === "linux") {
    const sink = await runCmd("pactl", ["get-default-sink"], 5000);
    const name = sink.stdout.toString().trim();
    if (name) console.log(`loopback do sink padrão: --device ${name}.monitor`);
  } else if (process.platform === "darwin") {
    console.log('use --device ":<índice>" da lista de áudio. Para capturar o som do sistema, instale um loopback (ex.: BlackHole) e roteie a saída para ele.');
  } else if (process.platform === "win32") {
    console.log('use --device "audio=<nome>". Para o som do sistema, ative "Mixagem estéreo" ou instale um cabo virtual (ex.: VB-CABLE).');
  }
  return any ? 0 : 1;
}
