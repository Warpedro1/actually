// Contagem do uso das APIs externas (painel "Uso das APIs" do /admin).
// O pipeline soma em memória o que cada chamada gastou e grava uma vez ao fim do
// trecho (`api_usage_add`). Nada aqui pode atrasar ou derrubar um alerta: a
// gravação roda depois do trabalho, e falha só vira log.
import type { ApiProvider, ApiUsageRow } from "@actually/db";
import { ANTHROPIC_CACHE_READ_FACTOR, ANTHROPIC_CACHE_WRITE_FACTOR, ANTHROPIC_PRICES_USD_PER_MTOK } from "./config";

export interface UsageMeter {
  record(row: ApiUsageRow): void;
  /** Guarda os cabeçalhos de limite (por minuto) da última resposta do provedor. */
  ratelimit(provider: ApiProvider, headers: Headers | Record<string, string>): void;
  /** Devolve e zera o acumulado. */
  drain(): { rows: ApiUsageRow[]; ratelimits: Record<string, Record<string, string>> };
}

export function createUsageMeter(): UsageMeter {
  let rows: ApiUsageRow[] = [];
  let limits: Record<string, Record<string, string>> = {};
  return {
    record(row) {
      rows.push(row);
    },
    ratelimit(provider, headers) {
      const picked = pickRateLimitHeaders(headers);
      if (picked) limits[provider] = picked;
    },
    drain() {
      const out = { rows, ratelimits: limits };
      rows = [];
      limits = {};
      return out;
    },
  };
}

/**
 * Cabeçalhos de limite de uma resposta: tudo que tiver "ratelimit" ou
 * "retry-after" no nome (cada provedor usa o seu prefixo). null se não houver.
 */
export function pickRateLimitHeaders(headers: Headers | Record<string, string>): Record<string, string> | null {
  const entries: [string, string][] =
    typeof (headers as Headers).forEach === "function" && typeof (headers as Headers).get === "function"
      ? (() => {
          const acc: [string, string][] = [];
          (headers as Headers).forEach((v, k) => acc.push([k, v]));
          return acc;
        })()
      : Object.entries(headers as Record<string, string>);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (key.includes("ratelimit") || key === "retry-after") out[key] = String(v);
  }
  return Object.keys(out).length ? out : null;
}

/** Campos de `message.usage` que entram na conta (todos opcionais nos mocks). */
export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Uma chamada à Anthropic → linha de uso com custo estimado pela tabela de preços. */
export function anthropicUsageRow(model: string, usage: AnthropicUsage | null | undefined): ApiUsageRow {
  const input = usage?.input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const price = ANTHROPIC_PRICES_USD_PER_MTOK[model];
  const cost = price
    ? (input * price.input +
        cacheRead * price.input * ANTHROPIC_CACHE_READ_FACTOR +
        cacheWrite * price.input * ANTHROPIC_CACHE_WRITE_FACTOR +
        output * price.output) /
      1_000_000
    : 0;
  return {
    provider: "anthropic",
    model,
    requests: 1,
    input_tokens: input + cacheRead + cacheWrite,
    output_tokens: output,
    cost_usd: cost,
  };
}
