// Cliente da API de ingestão (Vercel) e fila de envio de segmentos.
//
// A fila envia um segmento por vez, em ordem de seq. Falha transitória
// (rede, 5xx, 429) → retry com backoff exponencial, sem pular: o servidor é
// idempotente por (agent_id, seq), então "duplicate" conta como sucesso.
// "standby" também é sucesso — outro agente é o ativo e isso é normal.

import { EventEmitter } from "node:events";
import {
  ControlPollRequest,
  ControlPollResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  INGEST_TOKEN_HEADER,
  RegisterAgentRequest,
  RegisterAgentResponse,
  SegmentRequest,
  SegmentResponse,
} from "@actually/db";
import { backoffDelay, sleep as defaultSleep, type BackoffOptions } from "./backoff";
import type { SegmentDraft } from "./segmenter";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** 4xx são permanentes, exceto os que indicam "tente de novo". */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

export interface IngestClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class IngestClient {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly opts: IngestClientOptions) {
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  register(req: RegisterAgentRequest) {
    return this.post("/api/ingest/register", RegisterAgentRequest, req, RegisterAgentResponse);
  }

  heartbeat(req: HeartbeatRequest) {
    return this.post("/api/ingest/heartbeat", HeartbeatRequest, req, HeartbeatResponse);
  }

  segment(req: SegmentRequest) {
    return this.post("/api/ingest/segment", SegmentRequest, req, SegmentResponse);
  }

  controlPoll(req: ControlPollRequest) {
    return this.post("/api/control/poll", ControlPollRequest, req, ControlPollResponse);
  }

  /** GET /api/health — só status HTTP (o endpoint pode nem existir). */
  async health(): Promise<number> {
    const res = await this.fetch(`${this.baseUrl}/api/health`, {
      method: "GET",
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    return res.status;
  }

  private async post<Req, Res>(path: string, reqSchema: Schema<Req>, body: Req, resSchema: Schema<Res>): Promise<Res> {
    const valid = reqSchema.safeParse(body);
    if (!valid.success) throw new ApiError(`request inválido para ${path}: ${valid.error.message}`, null, false);
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [INGEST_TOKEN_HEADER]: this.opts.token },
        body: JSON.stringify(valid.data),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new ApiError(`${path}: falha de rede (${(err as Error).message})`, null, true);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new ApiError(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`, res.status, isRetryableStatus(res.status));
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // ex.: página HTML de proxy/CDN — transitório
      throw new ApiError(`${path}: resposta não é JSON`, res.status, true);
    }
    const parsed = resSchema.safeParse(json);
    if (!parsed.success) throw new ApiError(`${path}: resposta fora do contrato: ${parsed.error.message}`, res.status, true);
    return parsed.data;
  }
}

/** Segmento pronto para envio (o segmentador + relógio de parede). */
export interface CapturedSegment extends SegmentDraft {
  captured_at: string;
}

export interface QueueStats {
  pending: number;
  accepted: number;
  duplicate: number;
  standby: number;
  dropped: number;
  retries: number;
  lastLatencyMs: number | null;
  lastStatus: SegmentResponse["status"] | null;
}

export interface SegmentQueueEvents {
  result: [r: { seq: number; status: SegmentResponse["status"]; latencyMs: number; attempts: number }];
  retry: [r: { seq: number; attempt: number; delayMs: number; error: string }];
  dropped: [r: { seq: number; error: string }];
}

export interface SegmentQueueOptions {
  client: Pick<IngestClient, "segment">;
  backoff?: BackoffOptions;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface QueueItem {
  seq: number;
  seg: CapturedSegment;
  attempts: number;
}

export class SegmentQueue extends EventEmitter<SegmentQueueEvents> {
  private items: QueueItem[] = [];
  private nextSeq = 0;
  private agentId: string | null = null;
  private pumping = false;
  private readonly abort = new AbortController();
  private idleWaiters: (() => void)[] = [];
  readonly stats: QueueStats = {
    pending: 0,
    accepted: 0,
    duplicate: 0,
    standby: 0,
    dropped: 0,
    retries: 0,
    lastLatencyMs: null,
    lastStatus: null,
  };

  constructor(private readonly opts: SegmentQueueOptions) {
    super();
  }

  /** Antes do register os segmentos ficam na fila; aqui o envio começa. */
  setAgent(agentId: string): void {
    this.agentId = agentId;
    void this.pump();
  }

  enqueue(seg: CapturedSegment): number {
    const seq = this.nextSeq++;
    this.items.push({ seq, seg, attempts: 0 });
    this.stats.pending = this.items.length;
    void this.pump();
    return seq;
  }

  get size(): number {
    return this.items.length;
  }

  /** Espera esvaziar (true) ou estourar o tempo (false). */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.items.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.idleWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  stop(): void {
    this.abort.abort();
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.agentId) return;
    this.pumping = true;
    const sleep = this.opts.sleep ?? defaultSleep;
    const now = this.opts.now ?? Date.now;
    try {
      while (this.items.length > 0 && !this.abort.signal.aborted) {
        const item = this.items[0]!;
        item.attempts++;
        try {
          const res = await this.opts.client.segment({ agent_id: this.agentId, seq: item.seq, ...item.seg });
          this.items.shift();
          const latencyMs = Math.max(0, now() - Date.parse(item.seg.captured_at));
          this.stats[res.status]++;
          this.stats.lastStatus = res.status;
          this.stats.lastLatencyMs = latencyMs;
          this.emit("result", { seq: item.seq, status: res.status, latencyMs, attempts: item.attempts });
        } catch (err) {
          const e = err instanceof ApiError ? err : new ApiError(String(err), null, true);
          if (!e.retryable) {
            // não adianta repetir (400/401/404...): registra e segue para não travar a fila
            this.items.shift();
            this.stats.dropped++;
            this.emit("dropped", { seq: item.seq, error: e.message });
          } else {
            const delayMs = backoffDelay(item.attempts, this.opts.backoff ?? { baseMs: 500, maxMs: 10_000, jitter: 0.2 });
            this.stats.retries++;
            this.emit("retry", { seq: item.seq, attempt: item.attempts, delayMs, error: e.message });
            await sleep(delayMs, this.abort.signal);
          }
        }
        this.stats.pending = this.items.length;
      }
    } finally {
      this.pumping = false;
    }
    if (this.items.length === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }
}
