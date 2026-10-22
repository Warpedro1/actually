// RF15/RF14: rotas da carga da base pelo /admin. Só editor (token da sessão
// conferido pelo banco via is_editor, 2FA quando exigido); continuação e cron
// só com CRON_SECRET; o executor roda em after(), nunca na resposta.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { argOf, createMockDb, type QueryCall, type Result } from "./supabaseMock";

const state = vi.hoisted(() => ({
  db: null as unknown,
  afterTasks: [] as (() => unknown)[],
  /** token → resultado de is_editor() para aquele JWT */
  editor: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock("@/lib/server/db", () => ({
  getServiceClient: () => state.db,
  userClient: (token: string) => ({ rpc: async () => state.editor[token] ?? { data: false, error: null } }),
}));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    state.afterTasks.push(fn);
  },
}));

import { GET as cron } from "@/app/api/kb/cron/route";
import { POST as cancel } from "@/app/api/kb/jobs/[id]/cancel/route";
import { POST as createJob } from "@/app/api/kb/jobs/route";
import { POST as run } from "@/app/api/kb/run/route";
import { GET as status } from "@/app/api/kb/status/route";
import { kickWebFinds, needsRunner, supabaseJobStore } from "@/lib/server/kb";

const USER = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const jwt = (claims: Record<string, string>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const EDITOR_AAL1 = jwt({ sub: USER, aal: "aal1" });
const EDITOR_AAL2 = jwt({ sub: USER, aal: "aal2" });
const STRANGER = jwt({ sub: "55555555-5555-4555-8555-555555555555", aal: "aal1" });

const ok = (data: unknown): Result => ({ data, error: null });

function req(path: string, opts: { token?: string | null; method?: string; body?: unknown; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? EDITOR_AAL1 : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://actually.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  preset: "indicadores",
  title: "Indicadores",
  status: "running",
  current: { kind: "indicator-values", code: "ipca_12m", since: "2003-01-01" },
  current_attempts: 1,
  steps_done: 3,
  steps_failed: 0,
  steps_pending: 20,
  log: Array.from({ length: 120 }, (_, i) => ({ t: "2026-10-20T12:00:00Z", level: "info", msg: `linha ${i}` })),
  created_at: "2026-10-20T12:00:00Z",
  started_at: "2026-10-20T12:00:01Z",
  finished_at: null,
  updated_at: "2026-10-20T12:01:00Z",
  lease_until: new Date(Date.now() + 60_000).toISOString(),
  ...over,
});

let calls: QueryCall[];
function useDb(handlers: Parameters<typeof createMockDb>[0]) {
  const m = createMockDb(handlers);
  state.db = m.db;
  calls = m.calls;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("REQUIRE_MFA", "");
  vi.stubEnv("CRON_SECRET", "segredo");
  vi.stubEnv("VOYAGE_API_KEY", "v");
  vi.stubEnv("GOOGLE_FACTCHECK_API_KEY", "");
  vi.stubEnv("APIFY_TOKEN", "");
  state.afterTasks = [];
  state.editor = { [EDITOR_AAL1]: ok(true), [EDITOR_AAL2]: ok(true), [STRANGER]: ok(false) };
  useDb({ kb_jobs: () => ok([jobRow()]), "rpc:kb_counts": () => ok({ kb_factchecks: 10 }) });
});

describe("[RF14] [RF15] /api/kb/* só para editor", () => {
  it("[RF14] sem login 401, usuário que não é editor 403, token recusado pelo banco 401", async () => {
    expect((await status(req("/api/kb/status", { token: null }))).status).toBe(401);
    expect((await status(req("/api/kb/status", { token: STRANGER }))).status).toBe(403);
    state.editor.ruim = { data: null, error: { message: "JWT expired" } };
    expect((await status(req("/api/kb/status", { token: "ruim" }))).status).toBe(401);
    expect((await createJob(req("/api/kb/jobs", { token: STRANGER, method: "POST", body: { preset: "fontes" } }))).status).toBe(403);
    expect((await cancel(req(`/api/kb/jobs/${JOB}/cancel`, { token: null, method: "POST" }), { params: Promise.resolve({ id: JOB }) })).status).toBe(401);
    expect(calls.filter((c) => c.table === "kb_jobs")).toHaveLength(0);
  });

  it("[RF14] REQUIRE_MFA=1: sessão só com senha (aal1) é recusada; com TOTP (aal2) passa", async () => {
    vi.stubEnv("REQUIRE_MFA", "1");
    expect((await status(req("/api/kb/status", { token: EDITOR_AAL1 }))).status).toBe(403);
    expect((await status(req("/api/kb/status", { token: EDITOR_AAL2 }))).status).toBe(200);
  });
});

describe("[RF15] GET /api/kb/status", () => {
  it("[RF15] tarefas com rótulo da etapa e só o fim do log; chaves só como sim/não; resumo com ?counts=1", async () => {
    const r = await status(req("/api/kb/status?counts=1"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(body.jobs[0].current_label).toBe("Indicador ipca_12m");
    expect(body.jobs[0]).not.toHaveProperty("current");
    expect(body.jobs[0].log).toHaveLength(80);
    expect(body.jobs[0].log.at(-1).msg).toBe("linha 119");
    expect(body.env).toMatchObject({ VOYAGE_API_KEY: true, APIFY_TOKEN: false, CRON_SECRET: true });
    expect(JSON.stringify(body.env)).not.toContain("segredo");
    expect(body.counts).toEqual({ kb_factchecks: 10 });
    // lease válido: ninguém precisa retomar
    expect(state.afterTasks).toHaveLength(0);
  });

  it("[RF15] tarefa pendente sem lease (função caiu): a rota retoma em segundo plano", async () => {
    useDb({ kb_jobs: () => ok([jobRow({ lease_until: "2026-10-20T11:00:00Z" })]) });
    const r = await status(req("/api/kb/status"));
    expect(r.status).toBe(200);
    expect((await r.json()).counts).toBeNull();
    expect(state.afterTasks).toHaveLength(1);
  });
});

describe("[RF15] POST /api/kb/jobs", () => {
  it("[RF15] grava a fila planejada com quem pediu e começa a rodar em after()", async () => {
    useDb({ kb_jobs: () => ok({ id: JOB }) });
    const r = await createJob(req("/api/kb/jobs", { method: "POST", body: { preset: "checagens", since: "2026-01-01" } }));
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.id).toBe(JOB);
    // sem a chave do Google: só feeds, com aviso
    expect(body.notes.join(" ")).toMatch(/GOOGLE_FACTCHECK_API_KEY/);
    const row = argOf(calls.find((c) => c.table === "kb_jobs"), "insert") as Record<string, any>;
    expect(row.created_by).toBe(USER);
    expect(row.preset).toBe("checagens");
    expect(row.steps.map((s: { kind: string }) => s.kind)).toEqual(["factchecks-feeds", "embed-missing", "embed-missing", "status"]);
    expect(row.log.some((l: { level: string }) => l.level === "warn")).toBe(true);
    expect(state.afterTasks).toHaveLength(1);
  });

  it("[RF15] pedido inválido 400; preset que não pode rodar (sem APIFY_TOKEN) 400 sem gravar nada", async () => {
    expect((await createJob(req("/api/kb/jobs", { method: "POST", body: { preset: "documento", url: "javascript:alert(1)", title: "x", doc_type: "lei" } }))).status).toBe(400);
    const r = await createJob(req("/api/kb/jobs", { method: "POST", body: { preset: "youtube", url: "https://www.youtube.com/watch?v=a", doc_type: "debate" } }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/APIFY_TOKEN/);
    expect(calls.filter((c) => c.table === "kb_jobs")).toHaveLength(0);
    expect(state.afterTasks).toHaveLength(0);
  });
});

describe("[RF15] POST /api/kb/jobs/:id/cancel", () => {
  it("[RF15] cancela só tarefa pendente; id inválido 400; inexistente/terminada 404", async () => {
    const params = (id: string) => ({ params: Promise.resolve({ id }) });
    expect((await cancel(req("/x", { method: "POST" }), params("nao-e-uuid"))).status).toBe(400);
    useDb({ kb_jobs: () => ok([]) });
    expect((await cancel(req("/x", { method: "POST" }), params(JOB))).status).toBe(404);
    useDb({ kb_jobs: () => ok([{ id: JOB }]) });
    const r = await cancel(req("/x", { method: "POST" }), params(JOB));
    expect(r.status).toBe(200);
    const q = calls[0]!;
    expect(argOf(q, "update")).toMatchObject({ status: "canceled", lease_until: null });
    expect(argOf(q, "in")).toBe("status");
  });
});

describe("[RF15] [RNF05] continuação e cron só com CRON_SECRET", () => {
  it("[RNF05] /api/kb/run: sem CRON_SECRET no servidor 503; segredo errado 401; certo 202 e roda em after()", async () => {
    expect((await run(req("/api/kb/run", { method: "POST", token: null, bearer: "errado" }))).status).toBe(401);
    // token de editor não serve para a rota interna
    expect((await run(req("/api/kb/run", { method: "POST" }))).status).toBe(401);
    expect(state.afterTasks).toHaveLength(0);
    const r = await run(req("/api/kb/run", { method: "POST", token: null, bearer: "segredo" }));
    expect(r.status).toBe(202);
    expect(state.afterTasks).toHaveLength(1);
    vi.stubEnv("CRON_SECRET", "");
    expect((await run(req("/api/kb/run", { method: "POST", token: null, bearer: "" }))).status).toBe(503);
  });

  it("[RF15] cron: cria a atualização diária uma vez por dia e retoma a fila", async () => {
    let inserted: unknown = null;
    useDb({
      kb_jobs: (q) => {
        if (q.ops.some((o) => o.op === "insert")) {
          inserted = argOf(q, "insert");
          return ok({ id: JOB });
        }
        return ok([]);
      },
    });
    expect((await cron(req("/api/kb/cron", { token: null, bearer: "errado" }))).status).toBe(401);
    const r = await cron(req("/api/kb/cron", { token: null, bearer: "segredo" }));
    expect(await r.json()).toEqual({ created: JOB });
    expect(inserted).toMatchObject({ preset: "atualizacao-diaria", created_by: null });
    expect(state.afterTasks).toHaveLength(1);

    useDb({ kb_jobs: () => ok([{ id: "ja-existe" }]) });
    const again = await cron(req("/api/kb/cron", { token: null, bearer: "segredo" }));
    expect(await again.json()).toEqual({ created: null });
    expect(calls.some((c) => c.ops.some((o) => o.op === "insert"))).toBe(false);
  });
});

describe("[RF15] fila no Supabase", () => {
  it("[RF15] save só grava com o lease do dono e a tarefa rodando; 0 linhas = parar", async () => {
    useDb({ kb_jobs: () => ok([]) });
    const store = supabaseJobStore(state.db as never);
    expect(await store.save(JOB, "inv-1", { lease_until: null })).toBe(false);
    const q = calls[0]!;
    const eqs = q.ops.filter((o) => o.op === "eq").map((o) => o.args);
    expect(eqs).toEqual([["id", JOB], ["lease_owner", "inv-1"], ["status", "running"]]);

    useDb({ "rpc:kb_job_claim": () => ok([jobRow()]) });
    expect((await supabaseJobStore(state.db as never).claim("inv-2", 330))?.id).toBe(JOB);
    useDb({ "rpc:kb_job_claim": () => ok([]) });
    expect(await supabaseJobStore(state.db as never).claim("inv-2", 330)).toBeNull();
  });

  it("[RF15] precisa de executor só se houver pendente sem lease válido", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    expect(needsRunner([{ status: "done", lease_until: null }], now)).toBe(false);
    expect(needsRunner([{ status: "queued", lease_until: null }], now)).toBe(true);
    expect(needsRunner([{ status: "running", lease_until: "2026-10-20T12:01:00Z" }], now)).toBe(false);
    expect(needsRunner([{ status: "running", lease_until: "2026-10-20T11:59:00Z" }], now)).toBe(true);
  });
});

describe("[RF15] a base aprende com a web: disparo da fila", () => {
  it("[RF15] sem tarefa cria \"capturas-web\" e pede executor; com executor vivo não faz nada; erro não lança", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const origin = "https://actually.test";
    let inserted: unknown = null;
    useDb({
      kb_jobs: (q) => {
        if (q.ops.some((o) => o.op === "insert")) {
          inserted = argOf(q, "insert");
          return ok({ id: JOB });
        }
        return ok([]);
      },
    });
    await kickWebFinds(state.db as never, origin);
    expect(inserted).toMatchObject({ preset: "capturas-web", created_by: null });
    expect((inserted as { log: { msg: string }[] }).log[0]!.msg).toMatch(/pela checagem ao vivo/);
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/kb/run`, expect.objectContaining({ method: "POST" }));

    // já rodando com lease válido: nada
    fetchMock.mockClear();
    useDb({ kb_jobs: () => ok([{ preset: "capturas-web", status: "running", lease_until: new Date(Date.now() + 60_000).toISOString() }]) });
    await kickWebFinds(state.db as never, origin);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.some((c) => c.ops.some((o) => o.op === "insert"))).toBe(false);

    // na fila sem executor: só pede executor
    useDb({ kb_jobs: () => ok([{ preset: "capturas-web", status: "queued", lease_until: null }]) });
    await kickWebFinds(state.db as never, origin);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.ops.some((o) => o.op === "insert"))).toBe(false);

    // carga de outro tipo pendente (ex.: carga completa parada): só enfileira, não acorda o executor
    inserted = null;
    useDb({
      kb_jobs: (q) => {
        if (q.ops.some((o) => o.op === "insert")) {
          inserted = argOf(q, "insert");
          return ok({ id: JOB });
        }
        return ok([{ preset: "carga-completa", status: "queued", lease_until: null }]);
      },
    });
    fetchMock.mockClear();
    await kickWebFinds(state.db as never, origin);
    expect(inserted).toMatchObject({ preset: "capturas-web" });
    expect(fetchMock).not.toHaveBeenCalled();

    // banco fora: loga e segue
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    useDb({ kb_jobs: () => ({ data: null, error: { message: "fora do ar" } }) });
    await expect(kickWebFinds(state.db as never, origin)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
