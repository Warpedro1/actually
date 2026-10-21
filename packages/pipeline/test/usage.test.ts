// Contagem do uso das APIs (painel do /admin): custo estimado por modelo,
// cabeçalhos de limite e gravação depois do trecho — que nunca atrapalha o alerta.
import type { ApiUsageRow, IndicatorRef } from "@actually/db";
import { describe, expect, it } from "vitest";
import type { ExtractionOutput } from "../src/extract";
import { createPipeline } from "../src/index";
import { anthropicUsageRow, createUsageMeter, pickRateLimitHeaders } from "../src/usage";
import type { VerifyOutput } from "../src/verify";
import { PNAD, PNAD_VALUES, fakeAnthropic, makeDeps, MemoryStore, type FakeReply } from "./helpers";

const SEGMENT = "Boa noite. No meu governo o desemprego em 2023 foi de 12%, uma vergonha.";
const INDICATOR: IndicatorRef = { query: "desemprego", period: "2023", claimed_value: 12, unit: "%", kind: "level" };
const extracting = (): FakeReply<ExtractionOutput> => ({
  output: {
    claims: [{
      text_original: "o desemprego em 2023 foi de 12%", text_normalized: "A taxa de desemprego no Brasil em 2023 foi de 12%.",
      topic: "economia", numbers: [], indicator: { ...INDICATOR }, time_reference: null,
    }],
  },
});
const VERDICT: FakeReply<VerifyOutput> = {
  output: {
    rationale: "r", verdict: "contradito", confidence: 0.95,
    correction: "Segundo o IBGE, a taxa de desocupação em 2023 foi de 7,8% na média anual.",
    summary: "Desocupação média de 2023 foi 7,8%, não 12% (IBGE).",
    citations: [{ evidence_index: 1, quote: "2023 (média anual) = 7,8 %" }],
  },
};

/** MemoryStore que também grava uso (ou falha ao gravar). */
class UsageStore extends MemoryStore {
  usage: { rows: ApiUsageRow[]; ratelimits: Record<string, Record<string, string>> }[] = [];
  failUsage = false;
  async recordUsage(rows: ApiUsageRow[], ratelimits: Record<string, Record<string, string>>) {
    if (this.failUsage) throw new Error("banco fora");
    this.usage.push({ rows, ratelimits });
  }
}

function setup() {
  const store = new UsageStore({ series: [PNAD], values: PNAD_VALUES });
  const anthropic = fakeAnthropic({ extract: extracting, verify: () => VERDICT });
  const usage = createUsageMeter();
  const deps = makeDeps({ store, anthropic, usage });
  return { store, deps, usage, pipeline: createPipeline(deps) };
}

describe("[RNF03] contagem do uso das APIs", () => {
  it("[RNF03] custo estimado por modelo, com cache lido a 0,1× e escrito a 1,25×", () => {
    const haiku = anthropicUsageRow("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(haiku).toMatchObject({ provider: "anthropic", requests: 1, input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(haiku.cost_usd).toBeCloseTo(0.1 + 0.5, 10);
    const sonnet = anthropicUsageRow("claude-sonnet-5-5", {
      input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, output_tokens: 0,
    });
    expect(sonnet.input_tokens).toBe(3_000_000);
    expect(sonnet.cost_usd).toBeCloseTo(2 + 0.2 + 2.5, 10);
    expect(anthropicUsageRow("modelo-sem-preco", { input_tokens: 10 }).cost_usd).toBe(0);
    expect(anthropicUsageRow("claude-haiku-5-5", undefined)).toMatchObject({ input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  });

  it("[RNF03] guarda só os cabeçalhos de limite, de Headers ou de objeto", () => {
    const h = new Headers({ "anthropic-ratelimit-requests-remaining": "49", "retry-after": "3", "content-type": "x" });
    expect(pickRateLimitHeaders(h)).toEqual({ "anthropic-ratelimit-requests-remaining": "49", "retry-after": "3" });
    expect(pickRateLimitHeaders({ "X-RateLimit-Remaining": "10" })).toEqual({ "x-ratelimit-remaining": "10" });
    expect(pickRateLimitHeaders({ "content-type": "x" })).toBeNull();
  });

  it("[RNF03] trecho processado ⇒ uma gravação com extração (Haiku) e verificação (Sonnet); acumulado zera", async () => {
    const { store, usage, pipeline } = setup();
    const res = await pipeline.runPipeline(store.addSegment(SEGMENT).id);
    expect(res.alerts).toBe(1);
    expect(store.usage).toHaveLength(1);
    const models = store.usage[0]!.rows.filter((r) => r.provider === "anthropic").map((r) => r.model).sort();
    expect(models).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    expect(usage.drain()).toEqual({ rows: [], ratelimits: {} });
  });

  it("[RNF03] falha ao gravar o uso não derruba o pipeline nem tira o alerta", async () => {
    const { store, deps, pipeline } = setup();
    store.failUsage = true;
    const res = await pipeline.runPipeline(store.addSegment(SEGMENT).id);
    expect(res.alerts).toBe(1);
    expect(store.alerts).toHaveLength(1);
    expect(deps.logs.some((l) => l.event === "usage_record_failed")).toBe(true);
  });

  it("[RNF03] sem medidor (testes, eval) nada é gravado", async () => {
    const store = new UsageStore({ series: [PNAD], values: PNAD_VALUES });
    const deps = makeDeps({ store, anthropic: fakeAnthropic({ extract: extracting, verify: () => VERDICT }) });
    await createPipeline(deps).runPipeline(store.addSegment(SEGMENT).id);
    expect(store.usage).toHaveLength(0);
  });
});
