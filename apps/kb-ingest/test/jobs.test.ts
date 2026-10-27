// RF15: carga da base pelo /admin — presets → etapas, executor da fila com
// prazo/lease/retomada, manifestos embutidos e input do Actor do YouTube.
import { describe, expect, it } from "vitest";
import type { KbJobCreate, KbLogLine } from "@actually/db";
import { generatedSources } from "../scripts/gen-sources";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inputFromSchema } from "../src/apify/client";
import { AGENCY_QUERIES, checkingAgencies } from "../src/factchecks/agencySearch";
import { GOOGLE_QUERIES } from "../src/factchecks/google";
import { activeSeries } from "../src/indicators/catalog";
import type { Ctx } from "../src/lib/ctx";
import { mapUntil } from "../src/lib/http";
import { drainUsage, flushUsage, recordUsage } from "../src/lib/usage";
import { planJob, PlanError } from "../src/jobs/presets";
import { MAX_ATTEMPTS, runJobs, type JobPatch, type JobRow, type JobStore } from "../src/jobs/runner";
import { defaultApifyManifest, describeStep, runStep, type KbStep, type ReplayStep } from "../src/jobs/steps";
import { FakeDb, testCtx } from "./fakeDb";

const TODAY = "2026-10-20";
const ALL_KEYS = { GOOGLE_FACTCHECK_API_KEY: "g", VOYAGE_API_KEY: "v", APIFY_TOKEN: "a", TAVILY_API_KEY: "t" };
const plan = (req: KbJobCreate, env: Record<string, string> = ALL_KEYS) => planJob(req, { today: TODAY, env });
const kinds = (steps: KbStep[]) => steps.map((s) => s.kind);

describe("[RF15] manifestos embutidos para a Vercel", () => {
  it("[RF15] src/generated/sources.ts está em dia com sources/*.yaml (rode gen:sources)", () => {
    const onDisk = readFileSync(join(import.meta.dirname, "../src/generated/sources.ts"), "utf8");
    expect(onDisk).toBe(generatedSources());
  });

  it("[RF15] manifesto Apify embutido é válido e tem os jobs das agências", () => {
    const m = defaultApifyManifest();
    expect(m.crawl?.jobs?.map((j) => j.name)).toContain("lupa");
    expect(m.search?.input).toBeTruthy();
  });
});

describe("[RF15] presets do painel → fila de etapas", () => {
  it("[RF15] carga completa: fontes, todas as séries, Google por consulta, feeds, Senado, embeddings e resumo", () => {
    const p = plan({ preset: "carga-completa" });
    const ks = kinds(p.steps);
    expect(ks[0]).toBe("tiers");
    expect(ks.at(-1)).toBe("status");
    const series = activeSeries().filter((s) => s.fetch.kind !== "none");
    expect(p.steps.filter((s) => s.kind === "indicator-values")).toHaveLength(series.length);
    const google = p.steps.filter((s): s is Extract<KbStep, { kind: "factchecks-google" }> => s.kind === "factchecks-google");
    expect(google.map((g) => g.query)).toEqual(GOOGLE_QUERIES);
    // desde 2025-01-01 até hoje
    expect(google[0]!.maxAgeDays).toBe(Math.ceil((Date.parse(TODAY) - Date.parse("2025-01-01")) / 86_400_000));
    expect(ks).toContain("factchecks-feeds");
    expect(ks).toContain("senado-plan");
    expect(ks.filter((k) => k === "embed-missing")).toHaveLength(2);
    expect(p.notes).toEqual([]);
  });

  it("[RF15] sem chave do Google: pula a busca com aviso, mantém os feeds", () => {
    const p = plan({ preset: "checagens", source: "all" }, { VOYAGE_API_KEY: "v" });
    expect(kinds(p.steps)).not.toContain("factchecks-google");
    expect(kinds(p.steps)).toContain("factchecks-feeds");
    expect(p.notes.join(" ")).toMatch(/GOOGLE_FACTCHECK_API_KEY/);
    expect(() => plan({ preset: "checagens", source: "google" }, {})).toThrow(PlanError);
  });

  it("[RF15] sem Voyage: avisa que fica sem embedding; preset de embeddings é recusado", () => {
    const p = plan({ preset: "documento", url: "https://www.tse.jus.br/x.pdf", title: "Programa", doc_type: "programa" }, {});
    expect(kinds(p.steps)).toEqual(["document", "status"]);
    expect(p.notes.join(" ")).toMatch(/VOYAGE_API_KEY/);
    expect(() => plan({ preset: "embeddings" }, {})).toThrow(/VOYAGE_API_KEY/);
  });

  it("[RF15] Apify exige APIFY_TOKEN; vídeo do YouTube vira um run com os metadados do painel", () => {
    expect(() => plan({ preset: "youtube", url: "https://www.youtube.com/watch?v=abc", doc_type: "debate" }, {})).toThrow(/APIFY_TOKEN/);
    const p = plan({ preset: "youtube", url: "https://www.youtube.com/watch?v=abc", doc_type: "debate", person: "Lula", title: "Debate" });
    expect(p.steps[0]).toEqual({
      kind: "apify-start",
      target: { type: "youtube", video: { url: "https://www.youtube.com/watch?v=abc", doc_type: "debate", person: "Lula", title: "Debate", published_at: null } },
    });
    expect(() => plan({ preset: "apify-agencias", job: "inexistente" })).toThrow(PlanError);
    expect(kinds(plan({ preset: "apify-agencias" }).steps).filter((k) => k === "apify-start").length).toBeGreaterThan(3);
  });

  it("[RF15] atualização diária: checagens dos últimos 3 dias + indicadores + o que sobrou na fila da web", () => {
    const p = plan({ preset: "atualizacao-diaria" });
    const g = p.steps.find((s) => s.kind === "factchecks-google") as Extract<KbStep, { kind: "factchecks-google" }>;
    expect(g.maxAgeDays).toBe(3);
    expect(p.steps.find((s) => s.kind === "factchecks-feeds")).toEqual({ kind: "factchecks-feeds", since: "2026-10-17" });
    const ks = kinds(p.steps);
    expect(ks).toContain("indicator-values");
    expect(ks.indexOf("web-finds")).toBeGreaterThan(ks.lastIndexOf("indicator-values"));
    expect(ks.slice(-3)).toEqual(["embed-missing", "embed-missing", "status"]);
  });

  it("[RF15] sem chave da Tavily: checagens seguem com aviso de que os sites que recusam o download ficam de fora", () => {
    const { TAVILY_API_KEY: _, ...semTavily } = ALL_KEYS;
    expect(plan({ preset: "atualizacao-diaria" }, semTavily).notes.join(" ")).toMatch(/TAVILY_API_KEY.*UOL Confere/);
  });

  it("[RF15] capturas da web: fila kb_web_finds em lotes de 10 e resumo", () => {
    const p = plan({ preset: "capturas-web" });
    expect(p.steps).toEqual([{ kind: "web-finds", limit: 10 }, { kind: "status" }]);
    expect(p.notes).toEqual([]);
    expect(plan({ preset: "capturas-web" }, {}).notes.join(" ")).toMatch(/VOYAGE_API_KEY/);
  });

  it("[RF15] checagens das agências: uma busca por agência × consulta desde hoje − 45 dias; sem Tavily é recusado", () => {
    expect(() => plan({ preset: "checagens-agencias" }, { VOYAGE_API_KEY: "v" })).toThrow(PlanError);
    expect(() => plan({ preset: "checagens-agencias" }, { VOYAGE_API_KEY: "v" })).toThrow(/TAVILY_API_KEY/);

    const p = plan({ preset: "checagens-agencias" });
    const searches = p.steps.filter((s): s is Extract<KbStep, { kind: "factchecks-tavily" }> => s.kind === "factchecks-tavily");
    const agencies = checkingAgencies().map((a) => a.domain);
    expect(agencies).toEqual(expect.arrayContaining(["g1.globo.com/fato-ou-fake", "noticias.uol.com.br/confere", "checamos.afp.com", "aosfatos.org"]));
    expect(searches).toHaveLength(agencies.length * AGENCY_QUERIES.length);
    expect(new Set(searches.map((s) => s.domain))).toEqual(new Set(agencies));
    expect(searches.filter((s) => s.domain === "aosfatos.org").map((s) => s.query)).toEqual(AGENCY_QUERIES);
    expect(searches.every((s) => s.since === "2026-09-05")).toBe(true);
    expect(kinds(p.steps).slice(-3)).toEqual(["embed-missing", "embed-missing", "status"]);
    expect(p.title).toMatch(/desde 2026-09-05/);

    const since = plan({ preset: "checagens-agencias", since: "2026-10-01" }).steps[0] as Extract<KbStep, { kind: "factchecks-tavily" }>;
    expect(since.since).toBe("2026-10-01");
  });

  it("[RF15] todo tipo de etapa tem rótulo em português", () => {
    const all: KbStep[] = [
      ...plan({ preset: "carga-completa" }).steps,
      { kind: "factcheck-pages", origin: "feeds", candidates: [{ url: "https://lupa.uol.com.br/a" }] },
      { kind: "senado-votes", codigo: 1, from: "2024-01-01", to: "2024-12-31", offset: 10 },
      { kind: "senado-speeches", codigo: 1, from: "2024-01-01", to: "2024-12-31", offset: 0 },
      { kind: "apify-wait", target: { type: "search" }, runId: "r", datasetId: "d", startedAt: TODAY },
      { kind: "apify-items", target: { type: "crawl", job: "lupa" }, datasetId: "d", offset: 50 },
      ...plan({ preset: "checagens-agencias" }).steps,
      ...plan({ preset: "capturas-web" }).steps,
    ];
    for (const s of all) expect(describeStep(s)).toMatch(/\S/);
  });
});

// --- executor -------------------------------------------------------------------

/** Fila em memória com a mesma semântica de kb_job_claim (uma por vez, lease) e do save condicional. */
class MemoryStore implements JobStore {
  jobs: (JobRow & { status: string; owner: string | null; leaseUntil: number | null; finished_at?: string })[] = [];
  constructor(private clock: () => number) {}
  add(steps: KbStep[], extra: Partial<JobRow> = {}) {
    const job = { id: `j${this.jobs.length + 1}`, title: "t", steps, current: null, current_attempts: 0, steps_done: 0, steps_failed: 0, log: [] as KbLogLine[], status: "queued", owner: null, leaseUntil: null, ...extra };
    this.jobs.push(job);
    return job;
  }
  async claim(owner: string, leaseS: number) {
    const pending = this.jobs.filter((j) => j.status === "queued" || j.status === "running");
    if (pending.some((j) => j.leaseUntil !== null && j.leaseUntil >= this.clock())) return null;
    const j = pending[0];
    if (!j) return null;
    Object.assign(j, { status: "running", owner, leaseUntil: this.clock() + leaseS * 1000 });
    return structuredClone({ ...j });
  }
  async save(id: string, owner: string, patch: JobPatch) {
    const j = this.jobs.find((x) => x.id === id)!;
    if (j.owner !== owner || j.status !== "running") return false;
    const { lease_until, ...rest } = patch;
    Object.assign(j, structuredClone(rest), { leaseUntil: lease_until ? Date.parse(lease_until) : null });
    return true;
  }
}

function harness(stepFn: (step: KbStep, t: { advance: (ms: number) => void }) => KbStep[] | Promise<KbStep[]>) {
  let t = Date.parse("2026-10-20T12:00:00Z");
  const clock = () => t;
  const advance = (ms: number) => (t += ms);
  const store = new MemoryStore(clock);
  const ran: KbStep[] = [];
  const run = (owner = "inv-1", budgetMs = 100_000) =>
    runJobs({
      store,
      owner,
      budgetMs,
      leaseS: 330,
      now: clock,
      makeCtx: () => ({}) as Ctx,
      runStep: async (_ctx, step) => {
        ran.push(step);
        return stepFn(step, { advance });
      },
    });
  return { store, ran, run, advance };
}

const S = (n: number): KbStep => ({ kind: "indicator-values", code: `s${n}`, since: "2003-01-01" });

describe("[RF15] executor da fila (kb_jobs)", () => {
  it("[RF15] roda em ordem, continuações vão para a frente e a tarefa termina como done", async () => {
    const h = harness((step) => (step.kind === "indicator-values" && step.code === "s1" ? [S(10)] : []));
    const job = h.store.add([S(1), S(2)]);
    const r = await h.run();
    expect(h.ran.map((s) => (s as { code: string }).code)).toEqual(["s1", "s10", "s2"]);
    expect(r).toMatchObject({ jobs: 1, steps: 3, more: false });
    expect(job).toMatchObject({ status: "done", steps: [], current: null, steps_done: 3, steps_failed: 0, leaseUntil: null });
    expect(job.log.at(-1)!.msg).toMatch(/concluída: 3 etapas/);
  });

  it("[RF15] erro numa etapa conta como falha e a fila segue", async () => {
    const h = harness((step) => {
      if ((step as { code: string }).code === "s1") throw new Error("SIDRA fora do ar");
      return [];
    });
    const job = h.store.add([S(1), S(2)]);
    await h.run();
    expect(job).toMatchObject({ status: "done", steps_done: 1, steps_failed: 1 });
    expect(job.log.some((l) => l.level === "error" && /SIDRA fora do ar/.test(l.msg))).toBe(true);
  });

  it("[RF15] orçamento esgotado: grava a fila, devolve o lease e pede outra invocação; a próxima continua", async () => {
    const h = harness((_s, { advance }) => {
      advance(40_000);
      return [];
    });
    const job = h.store.add([S(1), S(2), S(3), S(4)]);
    const r1 = await h.run("inv-1", 100_000);
    expect(r1.more).toBe(true);
    expect(h.ran).toHaveLength(3); // começa etapas até o prazo (0, 40, 80 s)
    expect(job).toMatchObject({ status: "running", leaseUntil: null, current: null });
    expect(job.steps).toHaveLength(1);
    const r2 = await h.run("inv-2", 100_000);
    expect(r2.more).toBe(false);
    expect(job).toMatchObject({ status: "done", steps_done: 4 });
  });

  it("[RF15] função caiu no meio: lease vence, a etapa em andamento é repetida; na 3ª queda é abandonada", async () => {
    const h = harness(() => []);
    const job = h.store.add([S(2)], { current: S(1), current_attempts: 1 });
    await h.run();
    expect(h.ran.map((s) => (s as { code: string }).code)).toEqual(["s1", "s2"]);
    expect(job.log[0]!.msg).toMatch(/retomando .*tentativa 2/);

    const h2 = harness(() => []);
    const job2 = h2.store.add([S(2)], { current: S(1), current_attempts: MAX_ATTEMPTS });
    await h2.run();
    expect(h2.ran.map((s) => (s as { code: string }).code)).toEqual(["s2"]);
    expect(job2).toMatchObject({ status: "done", steps_failed: 1 });
  });

  it("[RF15] lease válido de outra invocação: não roda nada em paralelo", async () => {
    const h = harness(() => []);
    const job = h.store.add([S(1)]);
    Object.assign(job, { status: "running", owner: "outra", leaseUntil: Date.parse("2026-10-20T12:05:00Z") });
    const r = await h.run();
    expect(r).toEqual({ jobs: 0, steps: 0, more: false });
    expect(h.ran).toEqual([]);
  });

  it("[RF15] cancelada no meio: o executor para sem sobrescrever o status", async () => {
    let store: MemoryStore | undefined;
    const h = harness((step) => {
      if ((step as { code: string }).code === "s1") store!.jobs[0]!.status = "canceled";
      return [];
    });
    store = h.store;
    const job = h.store.add([S(1), S(2)]);
    await h.run();
    expect(h.ran).toHaveLength(1);
    expect(job.status).toBe("canceled");
  });

  it("[RF15] várias tarefas: uma depois da outra na mesma invocação", async () => {
    const h = harness(() => []);
    const a = h.store.add([S(1)]);
    const b = h.store.add([S(2)]);
    const r = await h.run();
    expect(r).toMatchObject({ jobs: 2, more: false });
    expect([a.status, b.status]).toEqual(["done", "done"]);
  });
});

describe("[RF15] utilitários das etapas", () => {
  it("[RF15] mapUntil não começa item depois do prazo e devolve o resto em ordem", async () => {
    let t = 0;
    const seen: number[] = [];
    const realNow = Date.now;
    Date.now = () => t;
    try {
      const r = await mapUntil([1, 2, 3, 4, 5], 1, 25, async (x) => {
        seen.push(x);
        t += 10;
      });
      expect(seen).toEqual([1, 2, 3]);
      expect(r).toEqual({ started: 3, rest: [4, 5] });
    } finally {
      Date.now = realNow;
    }
  });

  it("[RF15] input do Actor de transcrição sai do schema: requestListSources, lista de strings ou string", () => {
    const urls = ["https://www.youtube.com/watch?v=abc"];
    expect(inputFromSchema({ startUrls: { type: "array", editor: "requestListSources" }, maxItems: { type: "integer" } }, urls)).toEqual({
      startUrls: [{ url: urls[0] }],
    });
    expect(inputFromSchema({ urls: { type: "array", items: { type: "string" } } }, urls)).toEqual({ urls });
    expect(inputFromSchema({ videoUrl: { type: "string" } }, urls)).toEqual({ videoUrl: urls[0] });
    expect(() => inputFromSchema({ query: { type: "string" } }, urls)).toThrow(/campos: query/);
  });
});

describe("[RF15] uso das APIs na carga da base", () => {
  it("[RF15] o acumulado vai para api_usage numa chamada só; sem banco, só descarta; falha vira aviso", async () => {
    drainUsage();
    const calls: { fn: string; args: unknown }[] = [];
    const db = { rpc: async (fn: string, args: unknown) => (calls.push({ fn, args }), { error: null }) };
    recordUsage({ provider: "voyage", model: "voyage-3.5", requests: 1, input_tokens: 100 });
    recordUsage({ provider: "google_factcheck", requests: 1, units: 1 });
    await flushUsage(() => db as never);
    expect(calls).toEqual([{ fn: "api_usage_add", args: { p_rows: expect.arrayContaining([expect.objectContaining({ provider: "voyage" })]), p_ratelimits: {} } }]);
    expect((calls[0]!.args as { p_rows: unknown[] }).p_rows).toHaveLength(2);

    // nada acumulado: nem chama o banco
    let asked = false;
    await flushUsage(() => ((asked = true), db as never));
    expect(asked).toBe(false);

    const warnings: unknown[] = [];
    recordUsage({ provider: "apify", units: 1 });
    await flushUsage(() => ({ rpc: async () => ({ error: { message: "fora" } }) }) as never, (...a) => warnings.push(...a));
    expect(String(warnings[0])).toMatch(/fora/);
    expect(drainUsage()).toEqual([]);
  });
});

describe("[RNF08] reprocessamento da transcrição (preset reprocessar)", () => {
  const T0 = Date.parse("2026-10-24T14:00:00Z");
  const SHIFT = 3 * 86_400_000;
  const src = (id: number, agent: string, seq: number, s: number) => ({
    id, debate_id: "origem", agent_id: agent, seq, speaker_label: `s1-a:S${seq % 2}`, text: `fala ${id}`,
    t_start: s, t_end: s + 4, captured_at: new Date(T0 + s * 1000).toISOString(),
  });
  const step = (ids: number[], over: Partial<ReplayStep> = {}): ReplayStep => ({
    kind: "replay", target_debate_id: "novo", agents: { a1: "n1", a2: "n2" }, ids, done: 0, total: ids.length, shift_ms: SHIFT, ...over,
  });
  const setup = () => {
    const db = new FakeDb({ segments: [src(1, "a1", 0, 0), src(2, "a1", 1, 5), src(3, "a2", 0, 10), src(4, "a1", 2, 15)] });
    const ran: unknown[] = [];
    const runSegment = async (id: number | string) => (ran.push(id), { claims: 1, alerts: 0 });
    return { db, ran, runSegment, ...testCtx(db) };
  };
  const copies = (db: FakeDb) => db.rows("segments").filter((r) => r.debate_id === "novo");

  it("[RNF08] copia na ordem pedida, com o agente novo e o horário deslocado, e roda o pipeline em cada cópia", async () => {
    const { db, ran, runSegment, ctx, logs } = setup();
    const more = await runStep(ctx, step([1, 2, 3, 4]), { deadline: Infinity, runSegment });
    expect(more).toEqual([]);
    const out = copies(db);
    expect(out.map((r) => [r.agent_id, r.seq, r.text])).toEqual([["n1", 0, "fala 1"], ["n1", 1, "fala 2"], ["n2", 0, "fala 3"], ["n1", 2, "fala 4"]]);
    expect(out[1]).toMatchObject({ speaker_label: "s1-a:S1", t_start: 5, t_end: 9, captured_at: new Date(T0 + 5000 + SHIFT).toISOString() });
    // o espaçamento entre as falas é o da origem: a janela de contexto vê os mesmos vizinhos
    expect(Date.parse(String(out[3]!.captured_at)) - Date.parse(String(out[0]!.captured_at))).toBe(15_000);
    expect(ran).toEqual(out.map((r) => r.id));
    expect(logs.at(-1)).toBe("trechos 1–4 de 4: 4 afirmações, 0 alertas");
  });

  it("[RNF08] prazo esgotado: devolve a continuação com o que falta; a retomada não copia de novo", async () => {
    const { db, ran, runSegment, ctx } = setup();
    let t = 0;
    const slow = async (id: number | string) => ((t += 60_000), runSegment(id));
    const [cont] = await runStep(ctx, step([1, 2, 3, 4]), { deadline: 100_000, now: () => t, runSegment: slow });
    expect(cont).toMatchObject({ kind: "replay", ids: [3, 4], done: 2, total: 4 });
    expect(describeStep(cont!)).toBe("Reprocessar transcrição: 2 de 4 trechos");

    expect(await runStep(ctx, cont!, { deadline: Infinity, runSegment })).toEqual([]);
    expect(copies(db)).toHaveLength(4);
    expect(ran).toHaveLength(4);
    // a função caiu antes de gravar o progresso: o executor repete a mesma etapa, e o que já
    // foi copiado é pulado — sem cópia nem pipeline em dobro
    expect(await runStep(ctx, cont!, { deadline: Infinity, runSegment })).toEqual([]);
    expect(copies(db)).toHaveLength(4);
    expect(ran).toHaveLength(4);
  });

  it("[RNF08] falha no pipeline de um trecho conta e segue; sem o pipeline (CLI) a etapa recusa", async () => {
    const { db, runSegment, ctx, logs, warns } = setup();
    const flaky = async (id: number | string) => {
      if (copies(db).length === 2) throw new Error("Anthropic fora");
      return runSegment(id);
    };
    expect(await runStep(ctx, step([1, 2, 3]), { deadline: Infinity, runSegment: flaky })).toEqual([]);
    expect(copies(db)).toHaveLength(3);
    expect(warns.some((w) => /pipeline falhou — Anthropic fora/.test(w))).toBe(true);
    expect(logs.at(-1)).toMatch(/2 afirmações, 0 alertas; 1 com falha/);
    await expect(runStep(ctx, step([4]), { deadline: Infinity })).rejects.toThrow(/só roda no servidor do site/);
  });
});
