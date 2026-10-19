// Runner: liga fonte de áudio → Deepgram → segmentador → fila de envio.
// Usado pelo comando `run` (terminal) e pelo `daemon` (controle remoto).

import type { CaptureRole } from "@actually/db";
import { ApiError, IngestClient, SegmentQueue, type CapturedSegment } from "./api";
import { AudioSource, BYTES_PER_SECOND, type SourceSpec } from "./audio";
import { Backoff, sleep } from "./backoff";
import { DeepgramStream } from "./deepgram";
import { JsonlLogger, WallClockMap, logFileName } from "./log";
import { Segmenter, type SegmentDraft } from "./segmenter";
import { formatClock, formatStatus, type StatusLine } from "./status";

export interface RunnerConfig {
  debate: string;
  name: string;
  role: CaptureRole;
  source: SourceSpec;
  /** null em --dry-run. */
  apiUrl: string | null;
  dryRun: boolean;
  sttModel: string;
  sttFallbackModel: string;
  logDir: string;
  deepgramKey: string;
  ingestToken: string | null;
  /** Linhas legíveis (terminal, log_tail do daemon). */
  onLine?: (line: string) => void;
  statusLine?: StatusLine | null;
}

export interface RunnerStatus {
  state: "starting" | "running" | "stopping" | "stopped" | "error";
  agentId: string | null;
  /** null enquanto não houve heartbeat com sucesso. */
  active: boolean | null;
  lastSegmentAt: string | null;
  segmentsCreated: number;
  segmentsSent: number;
  queue: number;
  audioLevelDb: number | null;
  reconnects: number;
  error: string | null;
  logPath: string;
  clock: number;
  sttModel: string;
}

export interface RunnerExit {
  /** stopped = pedido; ended = arquivo terminou; fatal = não dá para continuar. */
  reason: "stopped" | "ended" | "fatal";
  error?: string;
}

export interface RunnerHandle {
  stop(): Promise<RunnerExit>;
  status(): RunnerStatus;
  done: Promise<RunnerExit>;
}

const HEARTBEAT_MS = 2000;
/** Replay rápido (--no-realtime): segura o ffmpeg se o WS acumular mais que isso. */
const MAX_WS_BACKLOG = 1 << 20;

export function startRunner(cfg: RunnerConfig): RunnerHandle {
  const line = (l: string) => {
    cfg.onLine?.(l);
    cfg.statusLine?.print(l);
  };
  const logger = new JsonlLogger(cfg.logDir, logFileName(cfg.debate, cfg.name));
  logger.write("start", {
    debate: cfg.debate,
    name: cfg.name,
    role: cfg.role,
    source: cfg.source,
    api: cfg.apiUrl,
    dry_run: cfg.dryRun,
    stt_model: cfg.sttModel,
    platform: process.platform,
  });

  const st: RunnerStatus = {
    state: "starting",
    agentId: null,
    active: null,
    lastSegmentAt: null,
    segmentsCreated: 0,
    segmentsSent: 0,
    queue: 0,
    audioLevelDb: null,
    reconnects: 0,
    error: null,
    logPath: logger.path,
    clock: 0,
    sttModel: cfg.sttModel,
  };
  let lastText: string | null = null;
  let heartbeatOk = true;

  const audio = new AudioSource({ spec: cfg.source });
  const dg = new DeepgramStream({
    apiKey: cfg.deepgramKey,
    model: cfg.sttModel,
    fallbackModel: cfg.sttFallbackModel,
    baseUrl: process.env.DEEPGRAM_WS_URL || undefined,
  });
  const segmenter = new Segmenter();
  const wall = new WallClockMap();
  const client =
    !cfg.dryRun && cfg.apiUrl && cfg.ingestToken ? new IngestClient({ baseUrl: cfg.apiUrl, token: cfg.ingestToken }) : null;
  const queue = client ? new SegmentQueue({ client }) : null;
  const stopCtl = new AbortController();
  const timers: NodeJS.Timeout[] = [];

  let resolveDone!: (e: RunnerExit) => void;
  const done = new Promise<RunnerExit>((r) => (resolveDone = r));
  let finishing: Promise<RunnerExit> | null = null;

  // --- áudio ---------------------------------------------------------------
  const isFile = cfg.source.kind === "file";
  audio.on("chunk", (buf, t) => {
    wall.record(t + buf.length / BYTES_PER_SECOND, Date.now());
    dg.send(buf, t);
    if (isFile && (!dg.isOpen || dg.backlogBytes > MAX_WS_BACKLOG)) audio.pause();
  });
  if (isFile) {
    // arquivo pode esperar: pausa enquanto o WS está fora para não perder nada
    timers.push(
      setInterval(() => {
        if (audio.isPaused && dg.isOpen && dg.backlogBytes < MAX_WS_BACKLOG / 2) audio.resume();
      }, 100),
    );
  }
  audio.on("log", (l) => logger.write("source_log", { line: l }));
  audio.on("restart", (info) => {
    logger.write("source_restart", info);
    line(`fonte caiu (${info.reason}); reiniciando em ${(info.delayMs / 1000).toFixed(1)} s`);
  });
  audio.on("end", () => void finish({ reason: "ended" }));
  audio.on("fatal", (err) => void finish({ reason: "fatal", error: err.message }));

  // --- Deepgram ------------------------------------------------------------
  dg.on("open", (info) => {
    logger.write("stt_open", info);
    if (info.reconnect) line(`STT reconectado (${info.model}); reenviados ${info.resentSeconds.toFixed(1)} s de áudio`);
    else line(`STT conectado (${info.model})`);
    if (st.state === "starting") st.state = "running";
  });
  dg.on("disconnected", (info) => {
    logger.write("stt_disconnected", info);
    line(`STT caiu (${info.code ?? ""} ${info.reason}); reconectando em ${(info.delayMs / 1000).toFixed(1)} s`);
  });
  dg.on("model_fallback", (info) => {
    st.sttModel = info.to;
    logger.write("stt_model_fallback", info);
    line(`modelo ${info.from} recusou a conexão (${info.reason}); usando ${info.to}`);
  });
  dg.on("fatal", (err) => void finish({ reason: "fatal", error: err.message }));
  dg.on("log", (l) => logger.write("stt_log", { line: l }));
  dg.on("event", (ev) => {
    switch (ev.type) {
      case "results":
        if (!ev.isFinal) {
          if (ev.transcript) lastText = `…${ev.transcript.slice(-60)}`;
          return;
        }
        if (ev.words.length > 0 || ev.speechFinal) {
          logger.write("final", {
            transcript: ev.transcript,
            end: ev.end,
            speech_final: ev.speechFinal,
            words: ev.words.map((w) => [w.text, round3(w.start), round3(w.end), w.speaker]),
          });
        }
        handleDrafts(segmenter.push({ type: "final", words: ev.words, speechFinal: ev.speechFinal }));
        return;
      case "utterance_end":
        handleDrafts(segmenter.push({ type: "utterance_end" }));
        return;
      case "metadata":
        logger.write("stt_metadata", { request_id: ev.requestId, model_info: ev.modelInfo });
        return;
      case "error":
        logger.write("stt_error", { message: ev.message });
        line(`STT erro: ${ev.message}`);
        return;
      default:
        return;
    }
  });

  let lastCapturedMs = 0;
  function handleDrafts(drafts: SegmentDraft[]): void {
    for (const d of drafts) {
      // monotônico: no replay rápido o mapa de relógio é grosseiro
      lastCapturedMs = Math.max(lastCapturedMs, Math.min(Date.now(), wall.wallAt(d.t_end)));
      const seg: CapturedSegment = { ...d, captured_at: new Date(lastCapturedMs).toISOString() };
      const seq = queue ? queue.enqueue(seg) : st.segmentsCreated;
      st.segmentsCreated++;
      logger.write("segment", { seq, ...seg });
      lastText = d.text.length > 60 ? `${d.text.slice(0, 60)}…` : d.text;
      line(`#${seq} [${d.speaker_label ?? "?"} ${formatClock(d.t_start)}–${formatClock(d.t_end)}] ${d.text}`);
      if (!queue) st.lastSegmentAt = seg.captured_at;
    }
  }

  // --- API -----------------------------------------------------------------
  queue?.on("result", (r) => {
    st.segmentsSent++;
    st.lastSegmentAt = new Date().toISOString();
    logger.write("sent", r);
  });
  queue?.on("retry", (r) => {
    logger.write("send_retry", r);
    if (r.attempt === 1 || r.attempt % 5 === 0) line(`envio #${r.seq} falhou (${r.error}); tentativa ${r.attempt}, nova em ${r.delayMs} ms`);
  });
  queue?.on("dropped", (r) => {
    logger.write("send_dropped", r);
    line(`envio #${r.seq} descartado (erro permanente): ${r.error} — está no log JSONL`);
  });

  async function registerLoop(): Promise<void> {
    if (!client || !queue) return;
    const backoff = new Backoff({ baseMs: 1000, maxMs: 15_000, jitter: 0.2 });
    while (!stopCtl.signal.aborted) {
      try {
        const res = await client.register({
          debate_slug: cfg.debate,
          name: cfg.name,
          source: cfg.source.kind,
          role: cfg.role,
        });
        st.agentId = res.agent_id;
        logger.write("registered", res);
        line(`registrado: agent_id=${res.agent_id} (${cfg.role})`);
        queue.setAgent(res.agent_id);
        startHeartbeat(res.agent_id);
        return;
      } catch (err) {
        const e = err as ApiError;
        if (e.status === 401 || e.status === 403) {
          void finish({ reason: "fatal", error: `API recusou o INGEST_TOKEN (${e.message})` });
          return;
        }
        const delay = backoff.next();
        logger.write("register_error", { error: e.message, delay_ms: delay });
        line(`register falhou (${e.message}); nova tentativa em ${(delay / 1000).toFixed(1)} s`);
        await sleep(delay, stopCtl.signal);
      }
    }
  }

  function startHeartbeat(agentId: string): void {
    let inFlight = false;
    const beat = async () => {
      if (inFlight || !client) return;
      inFlight = true;
      try {
        const { active } = await client.heartbeat({ agent_id: agentId });
        if (active !== st.active) {
          logger.write("active_changed", { active });
          line(active ? "► este agente agora é o ATIVO" : "este agente está em STANDBY (outro é o ativo)");
        }
        st.active = active;
        heartbeatOk = true;
      } catch (err) {
        if (heartbeatOk) line(`heartbeat falhou: ${(err as Error).message}`);
        heartbeatOk = false;
        logger.write("heartbeat_error", { error: (err as Error).message });
      } finally {
        inFlight = false;
      }
    };
    void beat();
    timers.push(setInterval(() => void beat(), HEARTBEAT_MS));
  }

  // --- status --------------------------------------------------------------
  function refresh(): RunnerStatus {
    st.queue = queue?.size ?? 0;
    st.audioLevelDb = audio.levelDb;
    st.reconnects = dg.reconnects + audio.restarts;
    st.clock = audio.clock;
    return st;
  }

  timers.push(
    setInterval(() => {
      refresh();
      cfg.statusLine?.update(
        formatStatus({
          mode: cfg.dryRun
            ? "DRY-RUN"
            : !st.agentId
              ? "REGISTRANDO"
              : !heartbeatOk
                ? "SEM API"
                : st.active
                  ? "ATIVO"
                  : "STANDBY",
          segments: st.segmentsCreated,
          queue: st.queue,
          lastLatencyMs: queue?.stats.lastLatencyMs ?? null,
          dgOpen: dg.isOpen,
          dgReconnects: dg.reconnects,
          sourceRestarts: audio.restarts,
          levelDb: audio.levelDb,
          lastText,
          clock: audio.clock,
        }),
      );
    }, 500),
  );

  // --- encerramento --------------------------------------------------------
  function finish(exit: RunnerExit): Promise<RunnerExit> {
    if (finishing) return finishing;
    st.state = "stopping";
    if (exit.error) {
      st.error = exit.error;
      line(`erro: ${exit.error}`);
    }
    finishing = (async () => {
      logger.write("finishing", { ...exit });
      if (exit.reason !== "ended") await audio.stop().catch(() => {});
      // CloseStream: o Deepgram devolve os últimos finais antes de fechar
      await dg.finish(exit.reason === "fatal" ? 2000 : 10_000);
      handleDrafts(segmenter.push({ type: "flush" }));
      stopCtl.abort();
      if (queue && st.agentId) {
        const drained = await queue.drain(exit.reason === "ended" ? 60_000 : 15_000);
        if (!drained) line(`encerrando com ${queue.size} segmento(s) não enviados (estão no log JSONL)`);
      }
      queue?.stop();
      for (const t of timers) clearInterval(t);
      refresh();
      cfg.statusLine?.clear();
      logger.write("end", { ...exit, segments: st.segmentsCreated, sent: st.segmentsSent, queue_left: queue?.size ?? 0 });
      await logger.close();
      st.state = exit.reason === "fatal" ? "error" : "stopped";
      resolveDone(exit);
      return exit;
    })();
    return finishing;
  }

  // --- partida -------------------------------------------------------------
  dg.start();
  audio.start();
  void registerLoop();
  line(`log: ${logger.path}`);

  return {
    stop: () => finish({ reason: "stopped" }),
    status: () => ({ ...refresh() }),
    done,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
