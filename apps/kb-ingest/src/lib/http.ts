// HTTP com timeout, retry, User-Agent identificável e limite por host.
// Toda ida à rede do kb-ingest passa por aqui: é o único lugar que decide
// quanto esperar, quando repetir e quantas requisições simultâneas um host recebe.
import { robotsAllows, robotsCrawlDelayMs } from "./robots";

const CONTACT = process.env.KB_INGEST_CONTACT?.trim();
export const USER_AGENT =
  `actually-kb-ingest/0.1 (checagem de fatos do debate presidencial 2026; sem fins comerciais` +
  (CONTACT ? `; ${CONTACT}` : "") +
  ")";

/** Token do User-Agent usado para casar grupos do robots.txt. */
export const ROBOTS_TOKEN = "actually-kb-ingest";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} em ${url}${bodySnippet ? ` — ${bodySnippet.slice(0, 200)}` : ""}`);
  }
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt não permite ${url}`);
  }
}

export interface FetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Tempo máximo de UMA tentativa. */
  timeoutMs?: number;
  /** Repetições além da primeira tentativa. */
  retries?: number;
  /** Consultar robots.txt antes (páginas; APIs documentadas não precisam). */
  respectRobots?: boolean;
  /** Status que não são erro para quem chama (ex.: 404 tratado como "não existe"). */
  okStatuses?: number[];
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Limite por host: concorrência baixa + intervalo mínimo entre requisições.
// ---------------------------------------------------------------------------
const MAX_PER_HOST = Number(process.env.KB_INGEST_MAX_PER_HOST ?? 2);
const MIN_INTERVAL_MS = Number(process.env.KB_INGEST_MIN_INTERVAL_MS ?? 400);

interface HostState {
  active: number;
  queue: (() => void)[];
  nextAt: number;
}
const hosts = new Map<string, HostState>();

function hostState(host: string): HostState {
  let s = hosts.get(host);
  if (!s) {
    s = { active: 0, queue: [], nextAt: 0 };
    hosts.set(host, s);
  }
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withHostSlot<T>(host: string, extraDelayMs: number, fn: () => Promise<T>): Promise<T> {
  const s = hostState(host);
  if (s.active >= MAX_PER_HOST) {
    await new Promise<void>((resolve) => s.queue.push(resolve));
  }
  s.active++;
  try {
    const wait = s.nextAt - Date.now();
    s.nextAt = Math.max(Date.now(), s.nextAt) + Math.max(MIN_INTERVAL_MS, extraDelayMs);
    if (wait > 0) await sleep(wait);
    return await fn();
  } finally {
    s.active--;
    s.queue.shift()?.();
  }
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 60_000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 60_000) : null;
}

/**
 * fetch com timeout por tentativa, backoff exponencial com jitter, Retry-After,
 * User-Agent do projeto e fila por host. Lança HttpError em status não-ok
 * (exceto `okStatuses`).
 */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const u = new URL(url);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  let crawlDelay = 0;
  if (opts.respectRobots) {
    if (!(await robotsAllows(url))) throw new RobotsDisallowedError(url);
    crawlDelay = (await robotsCrawlDelayMs(url)) ?? 0;
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withHostSlot(u.host, crawlDelay, () =>
        fetch(url, {
          method: opts.method ?? "GET",
          headers: { "User-Agent": USER_AGENT, ...(opts.headers ?? {}) },
          body: opts.body,
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
      if (res.ok || opts.okStatuses?.includes(res.status)) return res;
      const snippet = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
      const err = new HttpError(res.status, url, snippet);
      if (!RETRYABLE.has(res.status) || attempt === retries) throw err;
      lastErr = err;
      await sleep(retryAfterMs(res) ?? backoff(attempt));
    } catch (e) {
      if (e instanceof HttpError && !RETRYABLE.has(e.status)) throw e;
      if (e instanceof RobotsDisallowedError) throw e;
      lastErr = e;
      if (attempt === retries) break;
      await sleep(backoff(attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000) + Math.floor(Math.random() * 500);
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // Algumas origens (SGS, SIDRA) devolvem HTML com 200 em erro ou desafio anti-robô.
    throw new HttpError(res.status, url, `resposta não é JSON: ${text.slice(0, 160)}`);
  }
}

/** Executa `fn` sobre `items` com no máximo `limit` em paralelo, preservando a ordem. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
