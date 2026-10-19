// Backoff exponencial com jitter, usado em todo reinício/reconexão/retry.

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Fração de jitter (0.2 = ±20%) para máquinas diferentes não baterem juntas na API. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 15_000, jitter: 0.2 };

/** Atraso da tentativa `attempt` (1 = primeira repetição). */
export function backoffDelay(
  attempt: number,
  opts: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt - 1));
  const j = 1 + (random() * 2 - 1) * opts.jitter;
  return Math.max(0, Math.round(Math.min(opts.maxMs, exp * j)));
}

export class Backoff {
  private attempt = 0;
  constructor(
    private readonly opts: BackoffOptions = DEFAULT_BACKOFF,
    private readonly random: () => number = Math.random,
  ) {}

  next(): number {
    this.attempt++;
    return backoffDelay(this.attempt, this.opts, this.random);
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}

/** sleep que pode ser interrompido (ex.: no encerramento). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
