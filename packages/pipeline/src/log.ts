// Logs estruturados (uma linha JSON por evento) + utilitários de tempo.

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export const consoleLogger: Logger = (level, event, fields) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope: "pipeline", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const silentLogger: Logger = () => {};

export class TimeoutError extends Error {
  constructor(public readonly label: string, public readonly ms: number) {
    super(`timeout: ${label} (${ms} ms)`);
    this.name = "TimeoutError";
  }
}

/** Rejeita com TimeoutError se `p` não resolver em `ms`. Não cancela `p` — use AbortSignal onde der. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { error: err.message, error_name: err.name, ...(code !== undefined ? { error_code: code } : {}) };
  }
  return { error: String(err) };
}
