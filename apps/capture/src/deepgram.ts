// Deepgram streaming (WebSocket). Mantém um buffer circular do áudio recente
// para, ao reconectar, reenviar a partir do último resultado final — assim uma
// queda do WS não perde fala. Os tempos do Deepgram recomeçam em 0 a cada
// conexão; `offset` (tempo da captura do primeiro pedaço enviado nela) os leva
// de volta à linha do tempo da captura. Os números de speaker da diarização
// também recomeçam a cada conexão, por isso o rótulo leva a sessão do STT.
// Um watchdog derruba e reconecta um socket que aceita áudio mas não responde:
// nem pong (ping do WebSocket, que o servidor é obrigado a responder) nem
// mensagem do Deepgram ⇒ socket meio-aberto; pong sem nenhuma mensagem por
// bem mais tempo ⇒ sessão do Deepgram travada. O silêncio na transmissão não
// depende de o Deepgram mandar resultado vazio: o pong basta.

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { Backoff } from "./backoff";
import { BYTES_PER_SECOND, SAMPLE_RATE } from "./audio";
import type { Word } from "./segmenter";

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";
export const DEFAULT_STT_MODEL = "nova-3";
/** Se o modelo pedido recusar pt-BR (HTTP 400 no handshake), cai para este. */
export const FALLBACK_STT_MODEL = "nova-2";
/** Sem pong nem mensagem do Deepgram por isto, com áudio fluindo ⇒ reconecta (ms). */
export const DEFAULT_STT_STALL_MS = 15_000;
/**
 * Socket responde ping mas nenhuma mensagem do Deepgram por isto, com áudio
 * fluindo ⇒ reconecta (ms). Longo de propósito: cada reconexão abre uma sessão
 * nova e zera a atribuição (rótulos novos sem speaker_map).
 */
export const DEFAULT_STT_RESULT_STALL_MS = 60_000;
/** Pausa no envio de áudio maior que isto = fonte parada (não conta para o watchdog). */
const STALL_AUDIO_GAP_MS = 2000;

export function buildDeepgramUrl(model: string, base: string = DEEPGRAM_URL): string {
  const params = new URLSearchParams({
    model,
    language: "pt-BR",
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
    diarize: "true",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    vad_events: "true",
  });
  return `${base}?${params.toString()}`;
}

export type DgEvent =
  | {
      type: "results";
      isFinal: boolean;
      speechFinal: boolean;
      transcript: string;
      words: Word[];
      /** Fim do trecho coberto pelo resultado (linha da captura). */
      end: number;
    }
  | { type: "utterance_end"; lastWordEnd: number }
  | { type: "speech_started"; t: number }
  | { type: "metadata"; requestId: string | null; modelInfo: unknown }
  | { type: "error"; message: string };

interface RawWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

/**
 * Rótulo do speaker qualificado pela sessão do STT (ex.: "s3-a1b2c3:S0"). O
 * Deepgram renumera os speakers a cada conexão — e o standby tem a sua própria
 * —, então "S0" de outra sessão pode ser outra pessoa: com a sessão no rótulo,
 * após reconexão ou failover o rótulo novo não herda o speaker_map antigo e a
 * atribuição volta a "Afirmação feita no debate" até o editor remapear.
 */
export function speakerLabel(session: string, speaker: number): string {
  return `${session}:S${speaker}`;
}

/** Converte uma mensagem do Deepgram para tempos da captura. null = ignorar. */
export function parseDeepgramMessage(raw: string, offset: number, session: string): DgEvent | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (msg.type) {
    case "Results": {
      const channel = msg.channel as { alternatives?: { transcript?: string; words?: RawWord[] }[] } | undefined;
      const alt = channel?.alternatives?.[0];
      const words: Word[] = (alt?.words ?? []).map((w) => ({
        text: w.punctuated_word ?? w.word ?? "",
        start: offset + (w.start ?? 0),
        end: offset + (w.end ?? 0),
        speaker: typeof w.speaker === "number" ? speakerLabel(session, w.speaker) : null,
      }));
      const start = typeof msg.start === "number" ? msg.start : 0;
      const duration = typeof msg.duration === "number" ? msg.duration : 0;
      return {
        type: "results",
        isFinal: msg.is_final === true,
        speechFinal: msg.speech_final === true,
        transcript: alt?.transcript ?? "",
        words,
        end: offset + start + duration,
      };
    }
    case "UtteranceEnd":
      return { type: "utterance_end", lastWordEnd: offset + (typeof msg.last_word_end === "number" ? msg.last_word_end : 0) };
    case "SpeechStarted":
      return { type: "speech_started", t: offset + (typeof msg.timestamp === "number" ? msg.timestamp : 0) };
    case "Metadata":
      return { type: "metadata", requestId: typeof msg.request_id === "string" ? msg.request_id : null, modelInfo: msg.model_info };
    case "Error":
      return { type: "error", message: String(msg.description ?? msg.message ?? "erro desconhecido") };
    default:
      return null;
  }
}

export interface BufferedChunk {
  t: number;
  buf: Buffer;
}

/**
 * Índice do primeiro pedaço a reenviar numa reconexão: o que contém (ou vem
 * depois de) `resumeFrom`. Retorna chunks.length se não há nada a reenviar.
 */
export function selectResend(chunks: BufferedChunk[], resumeFrom: number): number {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (c.t + c.buf.length / BYTES_PER_SECOND > resumeFrom) return i;
  }
  return chunks.length;
}

export interface DeepgramStreamEvents {
  event: [ev: DgEvent];
  open: [info: { model: string; resentSeconds: number; reconnect: boolean }];
  disconnected: [info: { code: number | null; reason: string; delayMs: number }];
  model_fallback: [info: { from: string; to: string; reason: string }];
  /** Chave inválida etc. — não adianta reconectar. */
  fatal: [err: Error];
  log: [line: string];
}

export interface WsLike {
  readyState: number;
  bufferedAmount: number;
  send(data: Buffer | string): void;
  /** Ping do WebSocket; o servidor responde com 'pong'. */
  ping?(): void;
  close(code?: number): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface DeepgramStreamOptions {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  /** Áudio mantido para reenvio (s). Limita memória numa queda longa. */
  bufferSeconds?: number;
  keepAliveMs?: number;
  /**
   * Com áudio sendo enviado, nenhum pong nem mensagem do Deepgram por este
   * tempo ⇒ socket meio-aberto: derruba e reconecta (ms). O ping sai junto
   * com o KeepAlive (keepAliveMs).
   */
  stallTimeoutMs?: number;
  /**
   * Com áudio sendo enviado, nenhuma mensagem do Deepgram por este tempo,
   * mesmo com pong ⇒ sessão travada: derruba e reconecta (ms).
   */
  resultStallTimeoutMs?: number;
  /** Outro endpoint (ex.: servidor falso no ensaio local). */
  baseUrl?: string;
  wsFactory?: (url: string, headers: Record<string, string>) => WsLike;
}

export class DeepgramStream extends EventEmitter<DeepgramStreamEvents> {
  private ws: WsLike | null = null;
  private ready = false;
  private closing = false;
  private model: string;
  private triedFallback = false;
  private ring: BufferedChunk[] = [];
  private ringBytes = 0;
  private offset = 0;
  private audioClock = 0;
  private lastFinalEnd = 0;
  private connects = 0;
  private keepAlive: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  /** Sessão do STT da conexão atual (entra no speaker_label). */
  private session = "";
  /** Distingue os agentes: cada um conta as suas conexões a partir de 1. */
  private readonly instanceTag = randomBytes(3).toString("hex");
  /** Áudio enviado e ainda sem nenhuma resposta (pong ou mensagem) desde então (ms), ou null. */
  private unansweredSince: number | null = null;
  /** Áudio enviado e ainda sem nenhuma mensagem do Deepgram desde então (ms), ou null. */
  private noMessageSince: number | null = null;
  private lastSentAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly backoff = new Backoff({ baseMs: 500, maxMs: 10_000, jitter: 0.2 });
  private openedAt = 0;
  private closedResolve: (() => void) | null = null;
  reconnects = 0;

  constructor(private readonly opts: DeepgramStreamOptions) {
    super();
    this.model = opts.model;
  }

  get currentModel(): string {
    return this.model;
  }

  get isOpen(): boolean {
    return this.ready;
  }

  /** Sessão do STT da conexão atual ("" antes da primeira). */
  get currentSession(): string {
    return this.session;
  }

  /** Bytes ainda não transmitidos pelo socket (para backpressure no replay rápido). */
  get backlogBytes(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  start(): void {
    this.connect();
  }

  send(buf: Buffer, t: number): void {
    this.ring.push({ t, buf });
    this.ringBytes += buf.length;
    this.audioClock = t + buf.length / BYTES_PER_SECOND;
    const max = (this.opts.bufferSeconds ?? 120) * BYTES_PER_SECOND;
    while (this.ringBytes > max && this.ring.length > 1) this.ringBytes -= this.ring.shift()!.buf.length;
    if (this.ready && this.ws) {
      this.ws.send(buf);
      this.markSent(Date.now());
    }
  }

  /** Começa a contar a espera por resposta; áudio retomado após pausa recomeça a contagem. */
  private markSent(now: number): void {
    const resumed = now - this.lastSentAt > STALL_AUDIO_GAP_MS;
    if (this.unansweredSince === null || resumed) this.unansweredSince = now;
    if (this.noMessageSince === null || resumed) this.noMessageSince = now;
    this.lastSentAt = now;
  }

  /** CloseStream e espera o servidor mandar os últimos finais e fechar. */
  async finish(timeoutMs = 10_000): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopKeepAlive();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws?.terminate();
      return;
    }
    const closed = new Promise<void>((r) => (this.closedResolve = r));
    try {
      ws.send(JSON.stringify({ type: "CloseStream" }));
    } catch {
      /* socket já caiu */
    }
    await Promise.race([closed, new Promise((r) => setTimeout(r, timeoutMs))]);
    ws.terminate();
  }

  private connect(): void {
    const url = buildDeepgramUrl(this.model, this.opts.baseUrl);
    const headers = { Authorization: `Token ${this.opts.apiKey}` };
    const ws = this.opts.wsFactory
      ? this.opts.wsFactory(url, headers)
      : (new WebSocket(url, { headers, handshakeTimeout: 10_000 }) as unknown as WsLike);
    this.ws = ws;
    let down = false;
    const onDown = (code: number | null, reason: string) => {
      if (down) return;
      down = true;
      this.ready = false;
      this.stopKeepAlive();
      this.unansweredSince = null;
      this.noMessageSince = null;
      if (this.ws === ws) this.ws = null;
      if (this.closing) {
        this.closedResolve?.();
        return;
      }
      if (Date.now() - this.openedAt > 30_000) this.backoff.reset();
      const delayMs = this.backoff.next();
      this.emit("disconnected", { code, reason, delayMs });
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closing) this.connect();
      }, delayMs);
    };

    ws.on("open", () => {
      this.ready = true;
      this.openedAt = Date.now();
      const reconnect = this.connects++ > 0;
      if (reconnect) this.reconnects++;
      this.session = `s${this.connects}-${this.instanceTag}`;
      // reenvia o áudio ainda não finalizado; o offset vira o tempo do 1º pedaço
      const idx = selectResend(this.ring, this.lastFinalEnd);
      this.offset = idx < this.ring.length ? this.ring[idx]!.t : this.audioClock;
      let resent = 0;
      for (let i = idx; i < this.ring.length; i++) {
        ws.send(this.ring[i]!.buf);
        resent += this.ring[i]!.buf.length;
      }
      this.unansweredSince = null;
      this.noMessageSince = null;
      if (resent > 0) this.markSent(this.openedAt);
      this.startKeepAlive(ws, (reason) => {
        // derruba com o motivo (o close do terminate já não conta: down=true)
        this.emit("log", reason);
        onDown(null, reason);
        ws.terminate();
      });
      this.emit("open", { model: this.model, resentSeconds: resent / BYTES_PER_SECOND, reconnect });
    });

    ws.on("message", (data: Buffer | string, isBinary?: boolean) => {
      if (this.ws !== ws) return; // socket já abandonado (watchdog)
      // qualquer mensagem (inclusive resultado vazio) prova que o socket e a sessão vivem
      this.unansweredSince = null;
      this.noMessageSince = null;
      if (isBinary) return;
      const ev = parseDeepgramMessage(data.toString(), this.offset, this.session);
      if (!ev) return;
      if (ev.type === "results" && ev.isFinal) this.lastFinalEnd = Math.max(this.lastFinalEnd, ev.end);
      this.emit("event", ev);
    });

    ws.on("pong", () => {
      // o socket vive (a sessão do Deepgram pode estar calada: silêncio na transmissão)
      if (this.ws === ws) this.unansweredSince = null;
    });

    ws.on("unexpected-response", (req: { destroy(): void }, res: { statusCode?: number; headers: Record<string, unknown>; resume(): void }) => {
      const status = res.statusCode ?? 0;
      const dgError = String(res.headers["dg-error"] ?? "");
      res.resume();
      req.destroy();
      const reason = `HTTP ${status}${dgError ? ` — ${dgError}` : ""}`;
      if (status === 401 || status === 403) {
        this.closing = true;
        this.emit("fatal", new Error(`Deepgram recusou a chave (${reason}). Confira DEEPGRAM_API_KEY.`));
        onDown(status, reason);
        return;
      }
      if (status === 400 && !this.triedFallback && this.opts.fallbackModel && this.model !== this.opts.fallbackModel) {
        // ex.: modelo sem suporte a pt-BR → fallback documentado
        this.triedFallback = true;
        const from = this.model;
        this.model = this.opts.fallbackModel;
        this.emit("model_fallback", { from, to: this.model, reason });
      }
      onDown(status, reason);
    });

    ws.on("error", (err: Error) => {
      this.emit("log", `deepgram ws erro: ${err.message}`);
      onDown(null, err.message);
    });

    ws.on("close", (code: number, reason: Buffer) => onDown(code, reason?.toString() ?? ""));
  }

  private startKeepAlive(ws: WsLike, kill: (reason: string) => void): void {
    this.stopKeepAlive();
    // Sem KeepAlive o Deepgram fecha após ~10 s sem áudio (ex.: fonte reiniciando).
    // O ping prova que o socket vive mesmo quando o Deepgram não tem o que dizer.
    this.keepAlive = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "KeepAlive" }));
      try {
        ws.ping?.();
      } catch {
        /* socket caindo: o close/error decide */
      }
    }, this.opts.keepAliveMs ?? 4000);
    // Watchdog: socket meio-aberto (ex.: IP mudou) não dá close por minutos;
    // send() só acumula e nada volta (nem pong). Só conta com áudio fluindo.
    const stallMs = this.opts.stallTimeoutMs ?? DEFAULT_STT_STALL_MS;
    const resultStallMs = Math.max(stallMs, this.opts.resultStallTimeoutMs ?? DEFAULT_STT_RESULT_STALL_MS);
    this.watchdog = setInterval(() => {
      if (!this.ready || this.ws !== ws) return;
      const now = Date.now();
      if (now - this.lastSentAt > STALL_AUDIO_GAP_MS) return; // fonte parada: nada a responder
      const unansweredMs = this.unansweredSince === null ? 0 : now - this.unansweredSince;
      const noMessageMs = this.noMessageSince === null ? 0 : now - this.noMessageSince;
      if (unansweredMs >= stallMs) kill(`Deepgram sem resposta há ${(unansweredMs / 1000).toFixed(0)} s com áudio sendo enviado; reconectando`);
      else if (noMessageMs >= resultStallMs)
        kill(`Deepgram sem nenhuma mensagem há ${(noMessageMs / 1000).toFixed(0)} s com áudio sendo enviado (socket responde); reconectando`);
    }, Math.min(1000, stallMs));
  }

  private stopKeepAlive(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }
}
