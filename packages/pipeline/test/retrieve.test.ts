// Prazos da recuperação com relógio falso: a base (L1–L3) que estoura o prazo enquanto a
// L4 ainda roda pode chegar até a L4 terminar; sem L4 rodando, vale o prazo de cada camada.
// No ensaio de 18/10, a L3 estourou os 2,5 s em 20 de 24 verificações de um bloco enquanto a
// web levava 3–5 s: o prazo curto não economizou nada e jogou fora checagens da base.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TIMEOUTS_MS } from "../src/config";
import { retrieveAll } from "../src/retrieve/index";
import type { ExtractedClaim, RetrievalResult } from "../src/types";
import type { WebSearchFn } from "../src/retrieve/web";
import {
  DOC_CHUNK, FACTCHECK, MemoryStore, PNAD, PNAD_VALUES, fakeAnthropic, fakeRerank, fakeVector, fakeWeb, makeDeps,
  type DelayFixture, type KbFixture,
} from "./helpers";

const WEB_RESULT = {
  url: "https://g1.globo.com/saude/noticia/2013/10/22/dilma-sanciona-lei-do-mais-medicos.ghtml",
  title: "Dilma sanciona lei do Mais Médicos",
  content: "A presidente Dilma Rousseff sancionou nesta terça-feira (22) a lei que cria o programa Mais Médicos.",
  raw_content: "A presidente Dilma Rousseff sancionou nesta terça-feira (22) a lei que cria o programa Mais Médicos.",
  published_date: "2013-10-22",
  score: 0.9,
};

const CLAIM: ExtractedClaim = {
  text_original: "O Mais Médicos foi criado em 2015 pelo governo Temer",
  text_normalized: "O programa Mais Médicos foi criado em 2015 pelo governo Michel Temer.",
  topic: "saude", kind: "fato", measurable: null, numbers: [], indicator: null, reference: null, time_reference: null,
};
const L2_CLAIM: ExtractedClaim = {
  ...CLAIM,
  text_original: "o desemprego em 2023 foi de 12%",
  text_normalized: "A taxa de desemprego no Brasil em 2023 foi de 12%.",
  topic: "economia", kind: "estatistica",
  indicator: { query: "desemprego", period: "2023", claimed_value: 12, unit: "%", kind: "level" },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Roda a recuperação no relógio falso e devolve quando ela terminou (ms desde o início). */
async function run(opts: {
  kb?: KbFixture;
  delays?: DelayFixture;
  web?: WebSearchFn | null;
  /** settings.web_search do debate (padrão: ligada). */
  webEnabled?: boolean;
  /** Relevância que o rerank falso devolve (padrão 0,9: base forte). */
  relevance?: number;
  claim?: ExtractedClaim;
  embedding?: boolean;
}): Promise<{ r: RetrievalResult; ms: number; logs: { event: string; fields?: Record<string, unknown> }[] }> {
  const store = new MemoryStore(opts.kb ?? {}, {}, opts.delays ?? {});
  const deps = makeDeps({
    store, now: () => Date.now(), rerank: fakeRerank({ score: opts.relevance ?? 0.9 }), webSearch: opts.web ?? null,
    anthropic: fakeAnthropic({ extract: () => ({ output: { claims: [] } }), verify: () => ({ output: {} as never }) }),
  });
  const claim = opts.claim ?? CLAIM;
  const t0 = Date.now();
  let ms = -1;
  const p = retrieveAll(deps, claim, opts.embedding === false ? null : fakeVector(claim.text_normalized), { web: opts.webEnabled })
    .then((r) => ((ms = Date.now() - t0), r));
  await vi.advanceTimersByTimeAsync(30_000);
  return { r: await p, ms, logs: deps.logs };
}

const layer = (r: RetrievalResult, l: string) => r.layers.find((x) => x.layer === l);

describe("[RNF01] [RF03] prazos da base com a L4 em andamento", () => {
  it("L3 lenta com a web rodando: chega depois do prazo, sustenta sozinha e a web não entra", async () => {
    // antes: L3 descartada em 2,5 s ⇒ base fraca ⇒ esperava a web (5 s) e o alerta pagava o acréscimo
    const { r, ms, logs } = await run({ kb: { chunks: [DOC_CHUNK] }, delays: { matchChunks: 4_000 }, web: fakeWeb([WEB_RESULT], { delayMs: 5_000 }) });
    expect(ms).toBe(4_000);
    expect(r.used_web).toBe(false);
    expect(r.candidates.map((c) => c.layer)).toEqual(["L3"]);
    expect(r.candidates[0]?.weak).toBeUndefined();
    expect(layer(r, "L3")).toMatchObject({ latency_ms: 4_000 });
    expect(layer(r, "L3")?.error).toBeUndefined();
    expect(logs.some((l) => l.event === "layer_late" && l.fields?.layer === "L3")).toBe(true);
    expect(logs.some((l) => l.event === "layer_failed")).toBe(false);
  });

  it("L3 que chega depois da web é descartada inteira; a espera nunca passa do fim da web", async () => {
    const { r, ms, logs } = await run({ kb: { chunks: [DOC_CHUNK] }, delays: { matchChunks: 6_000 }, web: fakeWeb([WEB_RESULT], { delayMs: 5_000 }) });
    expect(ms).toBe(5_000);
    expect(r.used_web).toBe(true);
    expect(r.candidates.map((c) => c.layer)).toEqual(["L4"]);
    expect(layer(r, "L3")?.error).toMatch(/timeout/);
    expect(logs.some((l) => l.event === "layer_failed" && l.fields?.layer === "L3")).toBe(true);
  });

  it("web travada: o teto é o prazo da própria L4", async () => {
    const { r, ms } = await run({ kb: { chunks: [DOC_CHUNK] }, delays: { matchChunks: 60_000 }, web: fakeWeb([WEB_RESULT], { hang: true }) });
    expect(ms).toBe(TIMEOUTS_MS.L4);
    expect(r.candidates).toEqual([]);
    expect(layer(r, "L3")?.error).toMatch(/timeout/);
    expect(layer(r, "L4")?.error).toMatch(/timeout/);
  });

  it("sem web (busca desligada): vale o prazo de hoje da camada", async () => {
    const { r, ms, logs } = await run({ kb: { chunks: [DOC_CHUNK] }, delays: { matchChunks: 4_000 }, web: null });
    expect(ms).toBe(TIMEOUTS_MS.L3);
    expect(r.candidates).toEqual([]);
    expect(layer(r, "L3")?.error).toMatch(/timeout/);
    expect(logs.some((l) => l.event === "layer_failed" && l.fields?.layer === "L3")).toBe(true);
    expect(r.web_off).toBe("sem_chave");
  });

  it("busca desligada no debate com a Tavily configurada: não chama a web e vale o prazo da camada", async () => {
    const web = fakeWeb([WEB_RESULT], { delayMs: 5_000 });
    const { r, ms } = await run({ kb: { chunks: [DOC_CHUNK] }, delays: { matchChunks: 4_000 }, web, webEnabled: false });
    expect(web.calls).toBe(0);
    expect(ms).toBe(TIMEOUTS_MS.L3);
    expect(layer(r, "L4")).toBeUndefined();
    expect(r.used_web).toBe(false);
    expect(r.web_found).toBeNull();
    expect(r.web_off).toBe("debate");
  });

  it("busca desligada com a base fraca: o verificador recebe só a base, sem marca de evidência fraca", async () => {
    // com a busca ligada, o mesmo documento de relevância baixa vai junto com a web, marcado como fraco
    const on = await run({ kb: { chunks: [DOC_CHUNK] }, web: fakeWeb([WEB_RESULT]), relevance: 0.6 });
    expect(on.r.candidates.map((c) => [c.layer, c.weak ?? false])).toEqual([["L3", true], ["L4", false]]);

    const web = fakeWeb([WEB_RESULT]);
    const { r } = await run({ kb: { chunks: [DOC_CHUNK] }, web, webEnabled: false, relevance: 0.6 });
    expect(web.calls).toBe(0);
    expect(r.candidates.map((c) => c.layer)).toEqual(["L3"]);
    expect(r.candidates[0]?.weak).toBeUndefined();
  });

  it("busca ligada (padrão): a web roda e web_off fica vazio", async () => {
    const web = fakeWeb([WEB_RESULT]);
    const { r } = await run({ kb: { chunks: [DOC_CHUNK] }, web });
    expect(web.calls).toBe(1);
    expect(r.web_off).toBeNull();
  });

  it("web que terminou antes do prazo da base: vale o prazo de hoje (nada mais a esperar)", async () => {
    const { r, ms } = await run({ kb: { chunks: [DOC_CHUNK] }, delays: { matchChunks: 4_000 }, web: fakeWeb([WEB_RESULT], { delayMs: 1_000 }) });
    expect(ms).toBe(TIMEOUTS_MS.L3);
    expect(r.used_web).toBe(true);
    expect(layer(r, "L3")?.error).toMatch(/timeout/);
  });

  it("base forte no prazo não espera a camada lenta: latência igual à de hoje", async () => {
    // L1 forte em 100 ms; L3 lenta é cortada no prazo dela, como sempre (não espera a web)
    const { r, ms } = await run({
      kb: { factchecks: [FACTCHECK], chunks: [DOC_CHUNK] }, delays: { matchFactchecks: 100, matchChunks: 4_000 },
      web: fakeWeb([WEB_RESULT], { delayMs: 5_000 }),
    });
    expect(ms).toBe(TIMEOUTS_MS.L3);
    expect(r.used_web).toBe(false);
    expect(r.candidates.map((c) => c.layer)).toEqual(["L1"]);
    expect(layer(r, "L3")?.error).toMatch(/timeout/);
  });

  it("base rápida: nada muda (não espera a web)", async () => {
    const { r, ms } = await run({ kb: { chunks: [DOC_CHUNK] }, delays: { matchChunks: 300 }, web: fakeWeb([WEB_RESULT], { delayMs: 5_000 }) });
    expect(ms).toBe(300);
    expect(r.used_web).toBe(false);
  });

  it("L2 (indicador) que estoura o prazo com a web rodando chega com a comparação", async () => {
    const { r, ms } = await run({
      claim: L2_CLAIM, embedding: false, kb: { series: [PNAD], values: PNAD_VALUES },
      delays: { findIndicator: 3_000 }, web: fakeWeb([WEB_RESULT], { delayMs: 5_000 }),
    });
    expect(ms).toBe(3_000);
    expect(r.comparison).toMatchObject({ series_code: PNAD.code });
    expect(r.comparison?.status).not.toBe("no_data");
    expect(r.used_web).toBe(false);
    expect(r.candidates.map((c) => c.layer)).toEqual(["L2"]);
  });

  it("camada que falha depois do prazo (antes do fim da web) conta como falha, sem exceção", async () => {
    const store = new MemoryStore({ chunks: [DOC_CHUNK] }, {}, { matchChunks: 3_000 });
    store.failing.add("matchChunks");
    const deps = makeDeps({
      store, now: () => Date.now(), webSearch: fakeWeb([WEB_RESULT], { delayMs: 5_000 }),
      anthropic: fakeAnthropic({ extract: () => ({ output: { claims: [] } }), verify: () => ({ output: {} as never }) }),
    });
    const p = retrieveAll(deps, CLAIM, fakeVector(CLAIM.text_normalized));
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await p;
    expect(layer(r, "L3")?.error).toMatch(/falha simulada/);
    expect(r.used_web).toBe(true);
    expect(deps.logs.filter((l) => l.event === "layer_failed" && l.fields?.layer === "L3")).toHaveLength(1);
  });
});
