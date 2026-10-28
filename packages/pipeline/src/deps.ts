// Injeção de dependências: tudo que fala com rede/banco passa por aqui, para
// que o pipeline inteiro rode offline nos testes com mocks.
import Anthropic from "@anthropic-ai/sdk";
import { serviceClient } from "@actually/db";
import { voyageEmbed, type EmbedFn } from "./embed";
import { consoleLogger, type Logger } from "./log";
import { voyageRerank, type RerankFn } from "./rerank";
import { tavilySearch, type WebSearchFn } from "./retrieve/web";
import { supabaseStore, type PipelineStore } from "./store";
import { createUsageMeter, type UsageMeter } from "./usage";

/** Só o que o pipeline usa do cliente Anthropic (facilita o mock). */
export type AnthropicLike = Pick<Anthropic, "messages">;

export interface PipelineDeps {
  anthropic: AnthropicLike;
  embed: EmbedFn;
  rerank: RerankFn;
  /** null = L4 desligada (sem chave). Por debate, settings.web_search desliga em retrieveAll. */
  webSearch: WebSearchFn | null;
  store: PipelineStore;
  logger: Logger;
  /** Relógio em ms (Date.now) — injetável para latências determinísticas nos testes. */
  now: () => number;
  /** Contagem de uso das APIs (painel do /admin); ausente nos testes = não conta. */
  usage?: UsageMeter;
  /**
   * A base aprende com a web: as páginas da L4 vão para a fila kb_web_finds depois dos
   * alertas do trecho (só runPipeline; evaluateText nunca grava). Ausente/false = não grava.
   */
  learnFromWeb?: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`variável de ambiente ausente: ${name}`);
  return v;
}

let cached: PipelineDeps | null = null;

/**
 * Dependências reais a partir do env (ANTHROPIC_API_KEY, VOYAGE_API_KEY, TAVILY_API_KEY, Supabase).
 * KB_LEARN_FROM_WEB=0 desliga a gravação das páginas da web na base (ligada por padrão).
 */
export function defaultDeps(): PipelineDeps {
  if (cached) return cached;
  const voyageKey = required("VOYAGE_API_KEY");
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) consoleLogger("warn", "l4_disabled", { reason: "TAVILY_API_KEY ausente" });
  const usage = createUsageMeter();
  cached = {
    // retries curtos: ao vivo, atraso grande vale menos que silêncio.
    // fetch embrulhado só para guardar os cabeçalhos de limite (painel de uso).
    anthropic: new Anthropic({
      maxRetries: 1,
      fetch: async (url, init) => {
        const res = await fetch(url, init);
        usage.ratelimit("anthropic", res.headers);
        return res;
      },
    }),
    embed: voyageEmbed(voyageKey, fetch, usage),
    rerank: voyageRerank(voyageKey, fetch, usage),
    webSearch: tavilyKey ? tavilySearch(tavilyKey, fetch, usage) : null,
    store: supabaseStore(serviceClient()),
    logger: consoleLogger,
    now: Date.now,
    usage,
    learnFromWeb: process.env.KB_LEARN_FROM_WEB !== "0",
  };
  return cached;
}
