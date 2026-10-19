// Ponta a ponta com dependências simuladas (sem rede).
import type { DebateSettings, IndicatorRef } from "@actually/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractionOutput } from "../src/extract";
import { createPipeline } from "../src/index";
import type { VerifyOutput } from "../src/verify";
import {
  DOC_CHUNK, DOC_TEXT, FACTCHECK, PNAD, PNAD_VALUES, fakeAnthropic, fakeEmbed, fakeRerank, fakeWeb, makeDeps,
  MemoryStore, type FakeAnthropicScript, type FakeReply,
} from "./helpers";

type ClaimOut = ExtractionOutput["claims"][number];
const claimOut = (original: string, normalized: string, indicator: IndicatorRef | null = null): ClaimOut => ({
  text_original: original, text_normalized: normalized, topic: "economia", numbers: [],
  indicator: indicator ? { ...indicator } : null, time_reference: null,
});
const extracting = (...claims: ClaimOut[]) => (): FakeReply<ExtractionOutput> => ({ output: { claims } });
const verdict = (o: Partial<VerifyOutput>): FakeReply<VerifyOutput> => ({
  output: {
    rationale: "r", verdict: "contradito", confidence: 0.95, correction: "", summary: "", citations: [], ...o,
  },
});

// --- cenários ---------------------------------------------------------------
const L2_SEGMENT = "Boa noite. No meu governo o desemprego em 2023 foi de 12%, uma vergonha.";
const L2_CLAIM = claimOut("o desemprego em 2023 foi de 12%", "A taxa de desemprego no Brasil em 2023 foi de 12%.", {
  query: "desemprego", period: "2023", claimed_value: 12, unit: "%", kind: "level",
});
const L2_VERDICT = verdict({
  verdict: "contradito", confidence: 0.95,
  correction: "Segundo o IBGE, a taxa de desocupação em 2023 foi de 7,8% na média anual.",
  summary: "Desocupação média de 2023 foi 7,8%, não 12% (IBGE).",
  citations: [{ evidence_index: 1, quote: "2023 (média anual) = 7,8 %" }],
});

const DOC_SEGMENT = "O Mais Médicos foi criado em 2015 pelo governo Temer.";
const DOC_CLAIM = claimOut("O Mais Médicos foi criado em 2015 pelo governo Temer", "O programa Mais Médicos foi criado em 2015 pelo governo Michel Temer.");
const docVerdict = (quote: string) => verdict({
  verdict: "contradito", confidence: 0.95,
  correction: "O Mais Médicos foi criado pela Lei 12.871, de 22 de outubro de 2013, no governo Dilma.",
  summary: "O Mais Médicos é de 2013 (Lei 12.871), governo Dilma.",
  citations: [{ evidence_index: 1, quote }],
});

function setup(script: FakeAnthropicScript, kb: ConstructorParameters<typeof MemoryStore>[0] = {}, settings: Partial<DebateSettings> = {}) {
  const store = new MemoryStore(kb, settings);
  const anthropic = fakeAnthropic(script);
  const deps = makeDeps({ store, anthropic });
  return { store, anthropic, deps, pipeline: createPipeline(deps) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runPipeline", () => {
  it("L2: comparador + modelo concordam ⇒ vermelho em pending_review (HITL ligado), com evidência verificada", async () => {
    const { store, pipeline } = setup(
      { extract: extracting(L2_CLAIM), verify: () => L2_VERDICT },
      { series: [PNAD], values: PNAD_VALUES },
    );
    const seg = store.addSegment(L2_SEGMENT);
    const res = await pipeline.runPipeline(seg.id);
    expect(res).toMatchObject({ segment_id: seg.id, claims: 1, alerts: 1 });
    expect(res.latency_ms).toHaveProperty("extract");
    expect(res.latency_ms).toHaveProperty("e2e");

    expect(store.alerts).toHaveLength(1);
    const alert = store.alerts[0]!;
    expect(alert).toMatchObject({ verdict: "contradito", status: "pending_review", is_repeat: false, speaker_label: "SPEAKER_1" });
    const ver = store.verifications[0]!;
    expect(ver).toMatchObject({ verdict: "contradito", layer: "L2", model: "claude-sonnet-5-5" });
    expect(ver.final_score).toBeGreaterThanOrEqual(0.85);
    expect(ver.latency_ms).toHaveProperty("verify");
    expect(ver.latency_ms).toHaveProperty("e2e");
    expect(store.evidence).toEqual([
      expect.objectContaining({
        verification_id: ver.id, evidence_type: "indicator", url: PNAD.source_url, quote_verified: true,
        quote: "Série Taxa de desocupação (IBGE): 2023 (média anual) = 7,8 %",
      }),
    ]);
  });

  it("HITL desligado ⇒ vermelho publicado direto", async () => {
    const { store, pipeline } = setup(
      { extract: extracting(L2_CLAIM), verify: () => L2_VERDICT },
      { series: [PNAD], values: PNAD_VALUES },
      { require_red_approval: false },
    );
    await pipeline.runPipeline(store.addSegment(L2_SEGMENT).id);
    expect(store.alerts[0]!.status).toBe("published");
  });

  it("alerta só sai com citação verificada: trecho inventado ⇒ silêncio", async () => {
    const { store, pipeline, deps } = setup(
      { extract: extracting(DOC_CLAIM), verify: () => docVerdict("O Mais Médicos foi criado em 2013 por Dilma Rousseff no governo dela") },
      { chunks: [DOC_CHUNK] },
      { require_red_approval: false },
    );
    const res = await pipeline.runPipeline(store.addSegment(DOC_SEGMENT).id);
    expect(res.alerts).toBe(0);
    expect(store.alerts).toHaveLength(0);
    // a verificação fica registrada para auditoria, com a evidência marcada como não verificada
    expect(store.verifications[0]!.score_components).toMatchObject({ silence_reason: "sem_citacao_verificada" });
    expect(store.evidence.every((e) => !e.quote_verified)).toBe(true);
    expect(deps.logs.find((l) => l.event === "claim_decision")?.fields).toMatchObject({ silence_reason: "sem_citacao_verificada", alert: null });
  });

  it("mesma situação com trecho literal ⇒ vermelho publicado", async () => {
    const { store, pipeline } = setup(
      { extract: extracting(DOC_CLAIM), verify: () => docVerdict("criado pela Lei 12.871, sancionada em 22 de outubro de 2013, durante o governo Dilma Rousseff") },
      { chunks: [DOC_CHUNK] },
      { require_red_approval: false },
    );
    const res = await pipeline.runPipeline(store.addSegment(DOC_SEGMENT).id);
    expect(res.alerts).toBe(1);
    expect(store.alerts[0]).toMatchObject({ status: "published", verdict: "contradito" });
    expect(store.evidence[0]).toMatchObject({ url: DOC_CHUNK.url, quote_verified: true, source_tier: 1 });
  });

  it("refusal do verificador ⇒ silêncio (inconclusivo gravado), sem exceção", async () => {
    const { store, pipeline } = setup(
      { extract: extracting(L2_CLAIM), verify: () => ({ refusal: true }) },
      { series: [PNAD], values: PNAD_VALUES },
    );
    const res = await pipeline.runPipeline(store.addSegment(L2_SEGMENT).id);
    expect(res.alerts).toBe(0);
    expect(store.alerts).toHaveLength(0);
    expect(store.verifications[0]).toMatchObject({ verdict: "inconclusivo" });
    expect(store.verifications[0]!.score_components).toMatchObject({ silence_reason: "refusal" });
  });

  it("L2 divergente do modelo ⇒ silêncio", async () => {
    // afirmou 7,8% (bate com a série) mas o modelo diz contradito
    const claim = claimOut("o desemprego em 2023 foi de 7,8%", "A taxa de desemprego no Brasil em 2023 foi de 7,8%.", {
      query: "desemprego", period: "2023", claimed_value: 7.8, unit: "%", kind: "level",
    });
    const { store, pipeline } = setup(
      { extract: extracting(claim), verify: () => verdict({
        verdict: "contradito", confidence: 0.99, correction: "Em 2023 foi 7,8%.", summary: "x",
        citations: [{ evidence_index: 1, quote: "2023 (média anual) = 7,8 %" }],
      }) },
      { series: [PNAD], values: PNAD_VALUES },
      { require_red_approval: false },
    );
    const res = await pipeline.runPipeline(store.addSegment("Em 2023 o desemprego em 2023 foi de 7,8% e isso é ótimo.").id);
    expect(res.alerts).toBe(0);
    expect(store.verifications[0]!.score_components).toMatchObject({ silence_reason: "l2_divergente", l2_status: "match" });
  });

  it("repetição no debate ⇒ não reverifica; alerta de repetição com a mesma verificação e status", async () => {
    const { store, pipeline, anthropic } = setup(
      { extract: extracting(L2_CLAIM), verify: () => L2_VERDICT },
      { series: [PNAD], values: PNAD_VALUES },
    );
    await pipeline.runPipeline(store.addSegment(L2_SEGMENT).id);
    const res2 = await pipeline.runPipeline(store.addSegment(L2_SEGMENT).id);
    expect(res2).toMatchObject({ claims: 1, alerts: 1 });
    expect(anthropic.calls.filter((c) => c.model.includes("sonnet"))).toHaveLength(1);
    expect(store.verifications).toHaveLength(1);
    const [orig, rep] = store.alerts;
    expect(rep).toMatchObject({ is_repeat: true, repeat_of: orig!.id, verification_id: orig!.verification_id, status: orig!.status });
    expect(store.claims[1]!.duplicate_of).toBe(store.claims[0]!.id);
  });

  it("pré-filtro barra cumprimento sem gastar LLM", async () => {
    const { store, pipeline, anthropic } = setup({ extract: extracting(), verify: () => L2_VERDICT });
    const res = await pipeline.runPipeline(store.addSegment("Boa noite, obrigado.").id);
    expect(res).toMatchObject({ claims: 0, alerts: 0 });
    expect(anthropic.calls).toHaveLength(0);
  });

  it("extração que inventa trecho fora da fala é descartada", async () => {
    const { store, pipeline, anthropic } = setup(
      { extract: extracting(claimOut("o desemprego foi de 30%", "O desemprego foi de 30%.")), verify: () => L2_VERDICT },
    );
    const res = await pipeline.runPipeline(store.addSegment("Nós geramos empregos como nunca antes neste país.").id);
    expect(res.claims).toBe(0);
    expect(anthropic.calls.filter((c) => c.model.includes("sonnet"))).toHaveLength(0);
  });

  it("contexto dos segmentos anteriores vai para a extração", async () => {
    const { store, pipeline, anthropic } = setup({ extract: extracting(), verify: () => L2_VERDICT });
    store.addSegment("Candidato, e a sua política de emprego?", { speaker_label: "SPEAKER_0" });
    await pipeline.runPipeline(store.addSegment("No meu governo isso caiu muito.").id);
    expect(anthropic.calls[0]!.user).toContain("[SPEAKER_0] Candidato, e a sua política de emprego?");
    expect(anthropic.calls[0]!.user).toContain('<fala_atual locutor="SPEAKER_1">');
  });

  it("segmento inexistente ⇒ zero, sem exceção", async () => {
    const { pipeline } = setup({ extract: extracting(), verify: () => L2_VERDICT });
    await expect(pipeline.runPipeline(999)).resolves.toMatchObject({ claims: 0, alerts: 0 });
  });
});

describe("falhas e timeouts ⇒ silêncio, sem exceção", () => {
  const kbL2 = { series: [PNAD], values: PNAD_VALUES };

  async function runWithFakeTimers(p: Promise<unknown>) {
    await vi.advanceTimersByTimeAsync(60_000);
    return p;
  }

  it("Anthropic (extração) com erro", async () => {
    const { store, pipeline } = setup({ extract: () => ({ error: new Error("529 overloaded") }), verify: () => L2_VERDICT }, kbL2);
    await expect(pipeline.runPipeline(store.addSegment(L2_SEGMENT).id)).resolves.toMatchObject({ claims: 0, alerts: 0 });
  });

  it("Anthropic (extração) travada ⇒ timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, pipeline } = setup({ extract: () => ({ hang: true }), verify: () => L2_VERDICT }, kbL2);
    const res = await runWithFakeTimers(pipeline.runPipeline(store.addSegment(L2_SEGMENT).id));
    expect(res).toMatchObject({ claims: 0, alerts: 0 });
  });

  it("Anthropic (verificação) com erro e travada", async () => {
    const a = setup({ extract: extracting(L2_CLAIM), verify: () => ({ error: new Error("500") }) }, kbL2);
    await expect(a.pipeline.runPipeline(a.store.addSegment(L2_SEGMENT).id)).resolves.toMatchObject({ claims: 1, alerts: 0 });
    expect(a.store.alerts).toHaveLength(0);
    // erro transitório não grava verificação (a afirmação pode ser tentada de novo)
    expect(a.store.verifications).toHaveLength(0);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const b = setup({ extract: extracting(L2_CLAIM), verify: () => ({ hang: true }) }, kbL2);
    const res = await runWithFakeTimers(b.pipeline.runPipeline(b.store.addSegment(L2_SEGMENT).id));
    expect(res).toMatchObject({ claims: 1, alerts: 0 });
    expect(b.deps.logs.some((l) => l.event === "verify_timeout")).toBe(true);
  });

  it("Voyage (embeddings) fora ⇒ sem L1/L3 ⇒ silêncio", async () => {
    const store = new MemoryStore({ chunks: [DOC_CHUNK] }, { require_red_approval: false });
    const deps = makeDeps({
      store, embed: fakeEmbed({ fail: true }),
      anthropic: fakeAnthropic({ extract: extracting(DOC_CLAIM), verify: () => docVerdict(DOC_TEXT) }),
    });
    const res = await createPipeline(deps).runPipeline(store.addSegment(DOC_SEGMENT).id);
    expect(res).toMatchObject({ claims: 1, alerts: 0 });
    expect(deps.logs.some((l) => l.event === "embed_failed")).toBe(true);
    // a claim é gravada mesmo sem embedding
    expect(store.claims[0]!.embedding).toBeNull();
  });

  it("Voyage (embeddings) travado ⇒ timeout ⇒ silêncio", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const store = new MemoryStore({ chunks: [DOC_CHUNK] }, { require_red_approval: false });
    const deps = makeDeps({
      store, embed: fakeEmbed({ hang: true }),
      anthropic: fakeAnthropic({ extract: extracting(DOC_CLAIM), verify: () => docVerdict(DOC_TEXT) }),
    });
    const res = await runWithFakeTimers(createPipeline(deps).runPipeline(store.addSegment(DOC_SEGMENT).id));
    expect(res).toMatchObject({ alerts: 0 });
  });

  it("Voyage (rerank) fora com similaridade baixa ⇒ nada relevante ⇒ silêncio", async () => {
    const store = new MemoryStore({ chunks: [{ ...DOC_CHUNK, similarity: 0.5 }] }, { require_red_approval: false });
    const deps = makeDeps({
      store, rerank: fakeRerank({ fail: true }),
      anthropic: fakeAnthropic({ extract: extracting(DOC_CLAIM), verify: () => docVerdict(DOC_TEXT) }),
    });
    const res = await createPipeline(deps).runPipeline(store.addSegment(DOC_SEGMENT).id);
    expect(res.alerts).toBe(0);
    expect(deps.logs.some((l) => l.event === "rerank_failed")).toBe(true);
  });

  it("Tavily fora ou travado ⇒ silêncio", async () => {
    for (const web of [fakeWeb([], { fail: true }), fakeWeb([], { hang: true })]) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = new MemoryStore({}, { require_red_approval: false });
      const deps = makeDeps({
        store, webSearch: web,
        anthropic: fakeAnthropic({ extract: extracting(DOC_CLAIM), verify: () => docVerdict(DOC_TEXT) }),
      });
      const res = await runWithFakeTimers(createPipeline(deps).runPipeline(store.addSegment(DOC_SEGMENT).id));
      expect(res).toMatchObject({ claims: 1, alerts: 0 });
      expect(web.calls).toBe(1);
      expect(deps.logs.some((l) => l.event === "layer_failed" && l.fields?.layer === "L4")).toBe(true);
      vi.useRealTimers();
    }
  });

  it("L4 só roda quando a base não tem evidência", async () => {
    const web = fakeWeb([]);
    const store = new MemoryStore({ series: [PNAD], values: PNAD_VALUES });
    const deps = makeDeps({ store, webSearch: web, anthropic: fakeAnthropic({ extract: extracting(L2_CLAIM), verify: () => L2_VERDICT }) });
    await createPipeline(deps).runPipeline(store.addSegment(L2_SEGMENT).id);
    expect(web.calls).toBe(0);
  });

  it("banco falhando ao gravar a verificação ⇒ claim_failed logado, sem exceção", async () => {
    const { store, pipeline, deps } = setup({ extract: extracting(L2_CLAIM), verify: () => L2_VERDICT }, kbL2);
    store.failing.add("insertVerification");
    await expect(pipeline.runPipeline(store.addSegment(L2_SEGMENT).id)).resolves.toMatchObject({ alerts: 0 });
    expect(deps.logs.some((l) => l.event === "claim_failed" && l.level === "error")).toBe(true);
  });

  it("uma afirmação falhando não derruba as outras", async () => {
    const other = claimOut("o Mais Médicos foi criado em 2015 pelo governo Temer", DOC_CLAIM.text_normalized);
    const { store, pipeline } = setup(
      {
        extract: extracting(L2_CLAIM, other),
        verify: (u) => (u.includes("Mais Médicos")
          ? { error: new Error("boom") }
          : L2_VERDICT),
      },
      kbL2,
    );
    const res = await pipeline.runPipeline(store.addSegment(`${L2_SEGMENT} E o Mais Médicos foi criado em 2015 pelo governo Temer.`).id);
    expect(res).toMatchObject({ claims: 2, alerts: 1 });
  });
});

describe("evaluateText (modo seco)", () => {
  const BF_CLAIM = claimOut("o Bolsa Família atende 30 milhões de famílias", "O Bolsa Família atende 30 milhões de famílias.");
  const BF_VERDICT = verdict({
    verdict: "impreciso", confidence: 0.9,
    correction: "Segundo o MDS, o Bolsa Família pagou benefícios a 20,8 milhões de famílias em setembro de 2026.",
    summary: "São 20,8 milhões de famílias (MDS, set/2026), não 30 milhões.",
    citations: [{ evidence_index: 1, quote: "o Bolsa Família pagou benefícios a 20,8 milhões de famílias, segundo o MDS" }],
  });

  it("checagem L1 + citação literal ⇒ amarelo; nada é gravado", async () => {
    const { store, pipeline } = setup({ extract: extracting(BF_CLAIM), verify: () => BF_VERDICT }, { factchecks: [FACTCHECK] });
    const out = await pipeline.evaluateText("Hoje o Bolsa Família atende 30 milhões de famílias.", "");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      claim: "O Bolsa Família atende 30 milhões de famílias.", verdict: "impreciso", alert: "yellow", silence_reason: null, layer: "L1",
    });
    expect(out[0]!.evidence).toEqual([expect.objectContaining({ url: FACTCHECK.url, quote_verified: true, source_tier: 1 })]);
    expect(out[0]!.latency_ms).toHaveProperty("verify");
    expect(store.claims).toHaveLength(0);
    expect(store.verifications).toHaveLength(0);
    expect(store.alerts).toHaveLength(0);
  });

  it("settings sobrescrevem thresholds", async () => {
    const { pipeline } = setup({ extract: extracting(BF_CLAIM), verify: () => BF_VERDICT }, { factchecks: [FACTCHECK] });
    const out = await pipeline.evaluateText("Hoje o Bolsa Família atende 30 milhões de famílias.", "", { settings: { t_yellow: 0.95 } });
    expect(out[0]).toMatchObject({ alert: null, silence_reason: "abaixo_do_threshold" });
  });

  it("refusal ⇒ silêncio", async () => {
    const { pipeline } = setup({ extract: extracting(BF_CLAIM), verify: () => ({ refusal: true }) }, { factchecks: [FACTCHECK] });
    const out = await pipeline.evaluateText("Hoje o Bolsa Família atende 30 milhões de famílias.", "");
    expect(out[0]).toMatchObject({ alert: null, verdict: "inconclusivo", silence_reason: "refusal" });
  });

  it("correção com número que não está na fonte ⇒ silêncio", async () => {
    const bad = verdict({ ...("output" in BF_VERDICT ? BF_VERDICT.output : {}), correction: "São 21,5 milhões de famílias." });
    const { pipeline } = setup({ extract: extracting(BF_CLAIM), verify: () => bad }, { factchecks: [FACTCHECK] });
    const out = await pipeline.evaluateText("Hoje o Bolsa Família atende 30 milhões de famílias.", "");
    expect(out[0]).toMatchObject({ alert: null, silence_reason: "numero_sem_fonte" });
  });

  it("sem evidência ⇒ silêncio sem chamar o verificador", async () => {
    const { pipeline, anthropic } = setup({ extract: extracting(BF_CLAIM), verify: () => BF_VERDICT });
    const out = await pipeline.evaluateText("Hoje o Bolsa Família atende 30 milhões de famílias.", "");
    expect(out[0]).toMatchObject({ alert: null, silence_reason: "sem_evidencia", layer: null });
    expect(anthropic.calls.filter((c) => c.model.includes("sonnet"))).toHaveLength(0);
  });

  it("texto sem afirmação ⇒ lista vazia", async () => {
    const { pipeline } = setup({ extract: extracting(), verify: () => BF_VERDICT });
    expect(await pipeline.evaluateText("Eu vou acabar com a fome no Brasil.", "")).toEqual([]);
  });
});

describe("orçamento de latência (paralelismo)", () => {
  it("L1–L3 concorrentes e afirmações concorrentes: total bem abaixo da soma sequencial", async () => {
    const D = { extract: 60, embed: 40, L1: 120, L2: 120, L3: 120, verify: 120 };
    const store = new MemoryStore(
      { factchecks: [FACTCHECK], chunks: [DOC_CHUNK], series: [PNAD], values: PNAD_VALUES },
      {},
      // L2 = findIndicator + indicatorValues
      { matchFactchecks: D.L1, findIndicator: D.L2 / 2, indicatorValues: D.L2 / 2, matchChunks: D.L3 },
    );
    const c1 = { ...L2_CLAIM };
    const c2 = claimOut("o Mais Médicos foi criado em 2015", "O programa Mais Médicos foi criado em 2015.", {
      query: "desemprego", period: "2023", claimed_value: 7.8, unit: "%", kind: "level",
    });
    const deps = makeDeps({
      store,
      embed: fakeEmbed({ delayMs: D.embed }),
      anthropic: fakeAnthropic({
        extract: () => ({ output: { claims: [c1, c2] }, delayMs: D.extract }),
        verify: () => ({ ...verdict({ verdict: "inconclusivo", confidence: 0.2 }), delayMs: D.verify }),
      }),
    });
    const seg = store.addSegment(`${L2_SEGMENT} E o Mais Médicos foi criado em 2015, lembra?`);
    const t0 = Date.now();
    const res = await createPipeline(deps).runPipeline(seg.id);
    const elapsed = Date.now() - t0;

    expect(res.claims).toBe(2);
    const sequential = D.extract + D.embed + 2 * (D.L1 + D.L2 + D.L3 + D.verify);
    const parallel = D.extract + D.embed + Math.max(D.L1, D.L2, D.L3) + D.verify;
    // margem para o agendador do CI; ainda assim muito abaixo do sequencial
    expect(elapsed).toBeLessThan(sequential * 0.6);
    expect(elapsed).toBeGreaterThanOrEqual(parallel - 10);
    // dentro de cada afirmação, a recuperação levou ~ max(L1, L2, L3), não a soma
    for (const v of store.verifications) {
      expect(v.latency_ms.retrieve).toBeLessThan(D.L1 + D.L2 + D.L3 - 60);
    }
  });
});
