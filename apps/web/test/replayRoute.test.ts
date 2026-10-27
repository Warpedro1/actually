// Reprocessar a transcrição de um debate num debate de teste novo (/api/kb/replay):
// só editor; cria o debate de teste com as configurações e o mapa de vozes da origem,
// um agente por passada e a tarefa "reprocessar" com os trechos na ordem da fala.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayPass } from "@actually/db";
import { argOf, createMockDb, type QueryCall, type Result } from "./supabaseMock";

const state = vi.hoisted(() => ({
  db: null as unknown,
  afterTasks: [] as (() => unknown)[],
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
vi.mock("@actually/pipeline", () => ({ runPipeline: vi.fn() }));

import { GET, POST } from "@/app/api/kb/replay/route";
import { brasiliaStamp } from "@/lib/server/replay";
import { defaultPassIds, passLabel } from "@/lib/staff/replay";

const USER = "33333333-3333-4333-8333-333333333333";
const SRC = "11111111-1111-4111-8111-111111111111";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const A2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const jwt = (claims: Record<string, string>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const EDITOR = jwt({ sub: USER, aal: "aal1" });
const STRANGER = jwt({ sub: "55555555-5555-4555-8555-555555555555", aal: "aal1" });
const ok = (data: unknown): Result => ({ data, error: null });
const NOW = new Date("2026-10-27T18:30:05Z");

function req(path: string, opts: { token?: string | null; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? EDITOR : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://actually.test${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const seg = (id: number, agent: string, t: number, at: string) => ({ id, agent_id: agent, t_start: String(t), t_end: String(t + 4), captured_at: at });
// passada 1 inteira; passada 2 repetiu o começo depois
const SEGMENTS = [
  seg(10, A1, 0, "2026-10-24T14:21:51Z"),
  seg(11, A1, 5, "2026-10-24T14:21:56Z"),
  seg(12, A1, 3020, "2026-10-24T15:12:09Z"),
  seg(20, A2, 0, "2026-10-24T15:26:32Z"),
];

const has = (q: QueryCall, op: string) => q.ops.some((o) => o.op === op);
let calls: QueryCall[];
let inserted: Record<string, unknown[]>;

function useDb(segments = SEGMENTS) {
  let n = 0;
  inserted = {};
  const insert = (q: QueryCall, id: string) => {
    (inserted[q.table] ??= []).push(argOf(q, "insert"));
    return ok({ id });
  };
  const m = createMockDb({
    debates: (q) =>
      has(q, "insert")
        ? insert(q, "novo-debate")
        : ok({ id: SRC, slug: "lula-flavio-globo", title: "Debate da Globo", youtube_url: "https://youtu.be/x", settings: { t_red: 0.75 } }),
    segments: (q) => {
      const agents = argOf(q, "in") === "agent_id" ? (q.ops.find((o) => o.op === "in")!.args[1] as string[]) : null;
      return ok(agents ? segments.filter((s) => agents.includes(s.agent_id)) : segments);
    },
    capture_agents: (q) => {
      if (has(q, "insert")) return insert(q, `novo-agente-${++n}`);
      const ids = q.ops.find((o) => o.op === "in")!.args[1] as string[];
      return ok([A1, A2].filter((id) => ids.includes(id)).map((id) => ({ id, name: "casa", role: "primary" })));
    },
    speaker_map: (q) =>
      has(q, "insert")
        ? insert(q, "x")
        : ok([{ speaker_label: "s1-a37aa3:S0", person: "Lula", confirmed_by: USER }]),
    kb_jobs: (q) => insert(q, "tarefa"),
  });
  state.db = m.db;
  calls = m.calls;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("REQUIRE_MFA", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.afterTasks = [];
  state.editor = { [EDITOR]: ok(true), [STRANGER]: ok(false) };
  useDb();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("[RF14] /api/kb/replay só para editor", () => {
  it("[RF14] sem login 401, quem não é editor 403, sem tocar no banco", async () => {
    expect((await GET(req(`/api/kb/replay?debate=${SRC}`, { token: null }))).status).toBe(401);
    expect((await POST(req("/api/kb/replay", { token: STRANGER, method: "POST", body: { debate_id: SRC, agent_ids: [A1] } }))).status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(state.afterTasks).toHaveLength(0);
  });
});

describe("[RNF02] reprocessar a transcrição para medir de novo", () => {
  it("[RNF02] GET: uma linha por passada da captura, com nome, trechos e duração", async () => {
    expect((await GET(req("/api/kb/replay?debate=nao-e-uuid"))).status).toBe(400);
    const r = await GET(req(`/api/kb/replay?debate=${SRC}`));
    expect(r.status).toBe(200);
    const { passes } = (await r.json()) as { passes: ReplayPass[] };
    expect(passes).toEqual([
      { agent_id: A1, name: "casa", segments: 3, duration_s: 3024, first_at: "2026-10-24T14:21:51Z", last_at: "2026-10-24T15:12:09Z" },
      { agent_id: A2, name: "casa", segments: 1, duration_s: 4, first_at: "2026-10-24T15:26:32Z", last_at: "2026-10-24T15:26:32Z" },
    ]);
    // a passada repetida não vem marcada de saída
    expect(defaultPassIds(passes)).toEqual([A1]);
    expect(passLabel(passes[0]!)).toBe("casa — 3 trechos, 50 min 24 s de gravação, 24/10, 11:21 → 12:12");
  });

  it("[RNF02] POST: debate de teste com as mesmas configurações e o mesmo mapa de vozes; tarefa com os trechos na ordem da fala", async () => {
    const r = await POST(req("/api/kb/replay", { method: "POST", body: { debate_id: SRC, agent_ids: [A1] } }));
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({
      job_id: "tarefa",
      debate: { id: "novo-debate", slug: "lula-flavio-globo-reproc-20261027-153005", title: "Debate da Globo — reprocessamento 27/10, 15:30" },
      segments: 3,
    });
    expect(inserted.debates![0]).toMatchObject({
      slug: "lula-flavio-globo-reproc-20261027-153005",
      is_test: true,
      status: "ended",
      check_mode: "post",
      settings: { t_red: 0.75 },
      youtube_url: "https://youtu.be/x",
    });
    expect(String((inserted.debates![0] as { public_note: string }).public_note)).toMatch(/Não é checagem ao vivo/);
    // só a passada pedida vira agente no debate novo, parado (nunca recebe trecho de captura)
    expect(inserted.capture_agents).toEqual([{ debate_id: "novo-debate", name: "reprocessamento: casa", source: "file", role: "primary", active: false }]);
    expect(inserted.speaker_map).toEqual([[{ speaker_label: "s1-a37aa3:S0", person: "Lula", confirmed_by: USER, debate_id: "novo-debate" }]]);
    const job = inserted.kb_jobs![0] as { preset: string; created_by: string; steps: Record<string, unknown>[] };
    expect(job).toMatchObject({ preset: "reprocessar", created_by: USER });
    expect(job.steps).toEqual([
      {
        kind: "replay",
        target_debate_id: "novo-debate",
        agents: { [A1]: "novo-agente-1" },
        ids: [10, 11, 12],
        done: 0,
        total: 3,
        // o último trecho cai no horário do pedido; os outros mantêm o espaçamento original
        shift_ms: NOW.getTime() - Date.parse("2026-10-24T15:12:09Z"),
      },
    ]);
    // só os trechos da passada pedida, em ordem de fala
    const segQuery = calls.find((c) => c.table === "segments")!;
    expect(segQuery.ops.filter((o) => o.op === "order").map((o) => o.args[0])).toEqual(["captured_at", "id"]);
    expect(state.afterTasks).toHaveLength(1);
  });

  it("[RNF02] passada sem trechos neste debate: 400 e nada é criado", async () => {
    useDb(SEGMENTS.filter((s) => s.agent_id === A1));
    const r = await POST(req("/api/kb/replay", { method: "POST", body: { debate_id: SRC, agent_ids: [A1, A2] } }));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/passada sem trechos/);
    expect(inserted).toEqual({});
    expect(state.afterTasks).toHaveLength(0);
    expect((await POST(req("/api/kb/replay", { method: "POST", body: { debate_id: SRC, agent_ids: [] } }))).status).toBe(400);
  });

  it("[RNF02] carimbo do slug no horário de Brasília", () => {
    expect(brasiliaStamp(new Date("2026-10-27T02:05:09Z"))).toBe("20261026-230509");
  });
});
