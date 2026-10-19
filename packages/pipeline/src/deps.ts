// Injeção de dependências: tudo que fala com rede/banco passa por aqui, para
// que o pipeline inteiro rode offline nos testes com mocks.
import Anthropic from "@anthropic-ai/sdk";
import { serviceClient } from "@actually/db";
import { voyageEmbed, type EmbedFn } from "./embed";
import { consoleLogger, type Logger } from "./log";
import { voyageRerank, type RerankFn } from "./rerank";
import { tavilySearch, type WebSearchFn } from "./retrieve/web";
import { supabaseStore, type PipelineStore } from "./store";

/** Só o que o pipeline usa do cliente Anthropic (facilita o mock). */
export type AnthropicLike = Pick<Anthropic, "messages">;

export interface PipelineDeps {
  anthropic: AnthropicLike;
  embed: EmbedFn;
  rerank: RerankFn;
  /** null = L4 desligada (sem chave). */
  webSearch: WebSearchFn | null;
  store: PipelineStore;
  logger: Logger;
  /** Relógio em ms (Date.now) — injetável para latências determinísticas nos testes. */
  now: () => number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`variável de ambiente ausente: ${name}`);
  return v;
}

let cached: PipelineDeps | null = null;

/** Dependências reais a partir do env (ANTHROPIC_API_KEY, VOYAGE_API_KEY, TAVILY_API_KEY, Supabase). */
export function defaultDeps(): PipelineDeps {
  if (cached) return cached;
  const voyageKey = required("VOYAGE_API_KEY");
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) consoleLogger("warn", "l4_disabled", { reason: "TAVILY_API_KEY ausente" });
  cached = {
    // retries curtos: ao vivo, atraso grande vale menos que silêncio
    anthropic: new Anthropic({ maxRetries: 1 }),
    embed: voyageEmbed(voyageKey),
    rerank: voyageRerank(voyageKey),
    webSearch: tavilyKey ? tavilySearch(tavilyKey) : null,
    store: supabaseStore(serviceClient()),
    logger: consoleLogger,
    now: Date.now,
  };
  return cached;
}
