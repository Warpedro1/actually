import { beforeEach, describe, expect, it, vi } from "vitest";
import { argOf, createMockDb, type Result } from "./supabaseMock";

// --- mocks -------------------------------------------------------------------
const state = vi.hoisted(() => ({
  db: null as unknown,
  dbError: null as Error | null,
  afterTasks: [] as (() => unknown)[],
  pipeline: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({
  getServiceClient: () => {
    if (state.dbError) throw state.dbError;
    return state.db;
  },
}));
vi.mock("@actually/pipeline", () => ({ runPipeline: state.pipeline }));
vi.mock("next/server", () => ({
  after: (fn: () => unknown) => {
    state.afterTasks.push(fn);
  },
}));

import { POST as heartbeat } from "@/app/api/ingest/heartbeat/route";
import { POST as register } from "@/app/api/ingest/register/route";
import { POST as segment } from "@/app/api/ingest/segment/route";
import { POST as controlPoll } from "@/app/api/control/poll/route";

const TOKEN = "token-de-teste";
const AGENT = "11111111-1111-4111-8111-111111111111";
const DEBATE = "22222222-2222-4222-8222-222222222222";

function post(body: unknown, token: string | null = TOKEN) {
  return new Request("http://x/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-ingest-token": token } : {}) },
    body: JSON.stringify(body),
  });
}

const validSegment = {
  agent_id: AGENT,
  seq: 7,
  text: "O desemprego caiu pela metade.",
  speaker_label: "S0",
  t_start: 10,
  t_end: 14.2,
  captured_at: "2026-10-23T23:10:00.000Z",
};

const ok = (data: unknown): Result => ({ data, error: null });

beforeEach(() => {
  vi.stubEnv("INGEST_TOKEN", TOKEN);
  state.afterTasks = [];
  state.dbError = null;
  state.pipeline.mockReset();
});

describe("[RNF05] [RNF07] [RNF08] [RF12] POST /api/ingest/segment", () => {
  it("401 sem token", async () => {
    state.db = createMockDb({}).db;
    const res = await segment(post(validSegment, null));
    expect(res.status).toBe(401);
  });

  it("400 com corpo inválido", async () => {
    state.db = createMockDb({}).db;
    const res = await segment(post({ ...validSegment, seq: -1 }));
    expect(res.status).toBe(400);
  });

  it("standby: agente não ativo não grava nada", async () => {
    const mock = createMockDb({
      capture_agents: () => ok({ id: AGENT, debate_id: DEBATE, active: false }),
      segments: () => {
        throw new Error("não devia inserir");
      },
    });
    state.db = mock.db;
    const res = await segment(post(validSegment));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "standby" });
    expect(mock.calls.some((c) => c.table === "segments")).toBe(false);
    expect(state.afterTasks).toHaveLength(0);
  });

  it("duplicate: violação de unicidade (agent_id, seq) é idempotente", async () => {
    state.db = createMockDb({
      capture_agents: () => ok({ id: AGENT, debate_id: DEBATE, active: true }),
      segments: () => ({ data: null, error: { code: "23505", message: "duplicate key value" } }),
    }).db;
    const res = await segment(post(validSegment));
    expect(await res.json()).toEqual({ status: "duplicate" });
    expect(state.afterTasks).toHaveLength(0);
  });

  it("accepted: grava, responde na hora e roda o pipeline em after()", async () => {
    const mock = createMockDb({
      capture_agents: () => ok({ id: AGENT, debate_id: DEBATE, active: true }),
      segments: () => ok({ id: 991 }),
    });
    state.db = mock.db;
    let release!: () => void;
    state.pipeline.mockImplementation(
      () => new Promise((r) => (release = () => r({ segment_id: 991, claims: 1, alerts: 0, latency_ms: {} }))),
    );

    const res = await segment(post(validSegment));
    expect(await res.json()).toEqual({ status: "accepted", segment_id: 991 });
    // A resposta saiu antes do pipeline sequer começar.
    expect(state.pipeline).not.toHaveBeenCalled();

    const inserted = argOf(mock.calls.find((c) => c.table === "segments"), "insert") as Record<string, unknown>;
    expect(inserted).toMatchObject({ debate_id: DEBATE, agent_id: AGENT, seq: 7, speaker_label: "S0" });

    expect(state.afterTasks).toHaveLength(1);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const task = state.afterTasks[0]!();
    release();
    await task;
    expect(state.pipeline).toHaveBeenCalledWith(991);
  });

  it("[RF15] páginas da web na fila: cria a carga \"capturas-web\" e pede executor; sem páginas, nada", async () => {
    vi.stubEnv("CRON_SECRET", "segredo");
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const mock = createMockDb({
      capture_agents: () => ok({ id: AGENT, debate_id: DEBATE, active: true }),
      segments: () => ok({ id: 77 }),
      kb_jobs: (q) => (q.ops.some((o) => o.op === "insert") ? ok({ id: "job-web" }) : ok([])),
    });
    state.db = mock.db;
    state.pipeline.mockResolvedValue({ segment_id: 77, claims: 1, alerts: 0, latency_ms: {}, web_finds: 3 });
    await segment(post(validSegment));
    await state.afterTasks[0]!();
    const job = argOf(mock.calls.find((c) => c.table === "kb_jobs" && c.ops.some((o) => o.op === "insert")), "insert");
    expect(job).toMatchObject({ preset: "capturas-web", created_by: null });
    expect(fetchMock).toHaveBeenCalledWith("http://x/api/kb/run", expect.objectContaining({ method: "POST" }));

    const quiet = createMockDb({
      capture_agents: () => ok({ id: AGENT, debate_id: DEBATE, active: true }),
      segments: () => ok({ id: 78 }),
    });
    state.db = quiet.db;
    state.afterTasks = [];
    fetchMock.mockClear();
    state.pipeline.mockResolvedValue({ segment_id: 78, claims: 1, alerts: 0, latency_ms: {}, web_finds: 0 });
    await segment(post(validSegment));
    await state.afterTasks[0]!();
    expect(quiet.calls.some((c) => c.table === "kb_jobs")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("erro no pipeline é logado e não propaga", async () => {
    state.db = createMockDb({
      capture_agents: () => ok({ id: AGENT, debate_id: DEBATE, active: true }),
      segments: () => ok({ id: 5 }),
    }).db;
    state.pipeline.mockRejectedValue(new Error("LLM fora do ar"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await segment(post(validSegment));
    expect(res.status).toBe(200);
    await expect(state.afterTasks[0]!()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });

  it("404 para agente desconhecido", async () => {
    state.db = createMockDb({ capture_agents: () => ok(null) }).db;
    const res = await segment(post(validSegment));
    expect(res.status).toBe(404);
  });

  it("503 claro quando o Supabase não está configurado", async () => {
    state.dbError = new Error("variável de ambiente ausente: SUPABASE_SERVICE_ROLE_KEY");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await segment(post(validSegment));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("[RF12] POST /api/ingest/register e heartbeat", () => {
  it("register: debate por slug → insere agente → heartbeat inicial", async () => {
    const mock = createMockDb({
      debates: () => ok({ id: DEBATE }),
      capture_agents: () => ok({ id: AGENT }),
      "rpc:capture_heartbeat": () => ok(true),
    });
    state.db = mock.db;
    const res = await register(post({ debate_slug: "debate-23-10", name: "notebook", source: "youtube", role: "primary" }));
    expect(await res.json()).toEqual({ agent_id: AGENT, debate_id: DEBATE });
    expect(argOf(mock.calls.find((c) => c.table === "capture_agents"), "insert")).toEqual({
      debate_id: DEBATE,
      name: "notebook",
      source: "youtube",
      role: "primary",
    });
    expect(argOf(mock.calls.find((c) => c.table === "rpc:capture_heartbeat"), "rpc")).toEqual({ p_agent_id: AGENT });
  });

  it("register: 404 para debate inexistente", async () => {
    state.db = createMockDb({ debates: () => ok(null) }).db;
    const res = await register(post({ debate_slug: "nao-existe", name: "n", source: "file", role: "standby" }));
    expect(res.status).toBe(404);
  });

  it("heartbeat devolve {active}", async () => {
    state.db = createMockDb({ "rpc:capture_heartbeat": () => ok(false) }).db;
    const res = await heartbeat(post({ agent_id: AGENT }));
    expect(await res.json()).toEqual({ active: false });
  });
});

describe("[RF13] POST /api/control/poll", () => {
  const reported = { state: "running", audio_level_db: -20, segments_sent: 3, reconnects: 0 };
  const body = { machine_name: "notebook-casa", platform: "darwin-arm64", version: "0.1.0", reported };
  const MACHINE = "33333333-3333-4333-8333-333333333333";

  it("upsert por nome sem sobrescrever o desejado e devolve o desejado", async () => {
    const desired = { state: "running", debate_slug: "debate-23-10", source: "youtube", url: "https://youtu.be/x", role: "primary" };
    const mock = createMockDb({ capture_machines: () => ok({ id: MACHINE, desired }) });
    state.db = mock.db;
    const res = await controlPoll(post(body));
    const json = await res.json();
    expect(json.machine_id).toBe(MACHINE);
    expect(json.desired).toEqual(desired);
    expect(Date.parse(json.server_time)).not.toBeNaN();

    const call = mock.calls.find((c) => c.table === "capture_machines");
    const row = argOf(call, "upsert") as Record<string, unknown>;
    expect(row).toMatchObject({ name: "notebook-casa", platform: "darwin-arm64", version: "0.1.0", reported });
    expect(row).not.toHaveProperty("desired");
    expect(typeof row.last_seen).toBe("string");
    expect(call?.ops.find((o) => o.op === "upsert")?.args[1]).toEqual({ onConflict: "name" });
  });

  it("desejado inválido no banco vira stopped (nunca liga por engano)", async () => {
    state.db = createMockDb({ capture_machines: () => ok({ id: MACHINE, desired: { state: "talvez" } }) }).db;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await controlPoll(post(body));
    expect((await res.json()).desired).toEqual({ state: "stopped" });
  });

  it("401 sem token e 400 com reported inválido", async () => {
    state.db = createMockDb({}).db;
    expect((await controlPoll(post(body, "outro"))).status).toBe(401);
    expect((await controlPoll(post({ ...body, reported: { state: "voando" } }))).status).toBe(400);
  });
});

describe("[RNF05] [RF13] POST /api/control/poll recusa URL que viraria opção do yt-dlp", () => {
  const body = { machine_name: "notebook-casa", platform: "linux", version: "0.1.0", reported: { state: "idle" } };
  const MACHINE = "33333333-3333-4333-8333-333333333333";

  it.each([
    ["youtube", "--update-to=atacante/repo@v1"],
    ["youtube", "https://example.com/watch?v=dQw4w9WgXcQ"],
    ["file", "--config-locations=/tmp/x"],
  ])("source=%s url=%s ⇒ stopped (nunca chega ao daemon)", async (source, url) => {
    const desired = { state: "running", debate_slug: "debate-23-10", source, url, role: "primary" };
    state.db = createMockDb({ capture_machines: () => ok({ id: MACHINE, desired }) }).db;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await controlPoll(post(body));
    expect((await res.json()).desired).toEqual({ state: "stopped" });
  });
});
