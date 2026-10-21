// RNF05/RF14: painel "Uso das APIs" do /admin. Só editor; nunca devolve chave;
// cada provedor falha isolado (vira situação do cartão, nunca 500); cache de 60 s.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb, type QueryCall, type Result } from "./supabaseMock";

const state = vi.hoisted(() => ({
  db: null as unknown,
  editor: {} as Record<string, { data: unknown; error: unknown }>,
}));

vi.mock("@/lib/server/db", () => ({
  getServiceClient: () => state.db,
  userClient: (token: string) => ({ rpc: async () => state.editor[token] ?? { data: false, error: null } }),
}));

import { GET } from "@/app/api/ops/usage/route";
import { resetUsageCache } from "@/lib/server/apiUsage";
import type { UsageCard, UsageReport } from "@/lib/staff/usage";

const jwt = (claims: Record<string, string>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const EDITOR = jwt({ sub: "33333333-3333-4333-8333-333333333333", aal: "aal2" });
const STRANGER = jwt({ sub: "55555555-5555-4555-8555-555555555555", aal: "aal1" });
const ok = (data: unknown): Result => ({ data, error: null });

const KEYS = {
  ANTHROPIC_ADMIN_KEY: "sk-ant-admin-SEGREDO1",
  DEEPGRAM_API_KEY: "dg-SEGREDO2",
  APIFY_TOKEN: "apify-SEGREDO3",
  TAVILY_API_KEY: "tvly-SEGREDO4",
};

const SUMMARY = {
  usage: [
    { provider: "anthropic", model: "claude-haiku-5-5", janela: "hoje", requests: 10, input_tokens: 1000, output_tokens: 100, units: 0, cost_usd: 0.0002 },
    { provider: "anthropic", model: "claude-sonnet-5-5", janela: "hoje", requests: 2, input_tokens: 500, output_tokens: 50, units: 0, cost_usd: 0.0015 },
    { provider: "anthropic", model: "claude-haiku-5-5", janela: "mes", requests: 30, input_tokens: 3000, output_tokens: 300, units: 0, cost_usd: 0.0006 },
    { provider: "voyage", model: "", janela: "hoje", requests: 4, input_tokens: 900, output_tokens: 0, units: 0, cost_usd: 0 },
    { provider: "tavily", model: "", janela: "hora", requests: 3, input_tokens: 0, output_tokens: 0, units: 3, cost_usd: 0 },
  ],
  ratelimits: { anthropic: { headers: { "anthropic-ratelimit-requests-remaining": "3999" }, observed_at: "2026-10-21T12:00:00Z" } },
};

type Route = (url: URL, headers: Headers) => Response | Promise<Response>;
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Respostas certas de cada provedor; `over` troca uma rota por host+caminho. */
function providers(over: Record<string, Route> = {}): Record<string, Route> {
  return {
    "api.anthropic.com/v1/organizations/cost_report": (u) =>
      u.searchParams.get("page") === "p2"
        ? jsonRes({ data: [{ results: [{ amount: "250", currency: "USD" }] }], has_more: false, next_page: null })
        : jsonRes({ data: [{ results: [{ amount: "1500.25", currency: "USD" }] }, { results: [] }], has_more: true, next_page: "p2" }),
    "api.deepgram.com/v1/projects": () => jsonRes({ projects: [{ project_id: "p1", name: "actually" }] }),
    "api.deepgram.com/v1/projects/p1/balances": () => jsonRes({ balances: [{ balance_id: "b1", amount: 187.3, units: "usd" }] }),
    "api.apify.com/v2/users/me/limits": () =>
      jsonRes({ data: { current: { monthlyUsageUsd: 2.5 }, limits: { maxMonthlyUsageUsd: 5 }, monthlyUsageCycle: { endAt: "2026-11-03T00:00:00.000Z" } } }),
    "api.tavily.com/usage": () => jsonRes({ key: { usage: 150, limit: null }, account: { current_plan: "Researcher", plan_usage: 812, plan_limit: 1000 } }),
    ...over,
  };
}

let fetched: { url: URL; headers: Headers }[];
function stubFetch(routes: Record<string, Route>) {
  fetched = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    fetched.push({ url, headers });
    const route = routes[`${url.host}${url.pathname}`];
    if (!route) throw new Error(`fetch inesperado: ${url}`);
    return route(url, headers);
  });
}

let calls: QueryCall[];
function useDb(over: Record<string, () => Result> = {}) {
  const m = createMockDb({
    "rpc:api_usage_summary": () => ok(SUMMARY),
    "rpc:ops_db_size": () => ok({ db_bytes: 100 * 1024 * 1024, tables: [{ table: "kb_chunks", bytes: 60 * 1024 * 1024 }] }),
    ...over,
  });
  state.db = m.db;
  calls = m.calls;
}

const req = (token: string | null = EDITOR, qs = "") =>
  new Request(`https://actually.test/api/ops/usage${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function report(r?: Request): Promise<{ res: Response; text: string; body: UsageReport; card: (id: UsageCard["id"]) => UsageCard }> {
  const res = await GET(r ?? req());
  const text = await res.text();
  const body = JSON.parse(text) as UsageReport;
  const card = (id: UsageCard["id"]) => {
    const c = body.cards.find((x) => x.id === id);
    if (!c) throw new Error(`sem cartão ${id}`);
    return c;
  };
  return { res, text, body, card };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("REQUIRE_MFA", "");
  vi.stubEnv("SUPABASE_DB_LIMIT_MB", "");
  for (const [k, v] of Object.entries(KEYS)) vi.stubEnv(k, v);
  state.editor = { [EDITOR]: ok(true), [STRANGER]: ok(false) };
  resetUsageCache();
  useDb();
  stubFetch(providers());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[RF14] [RNF05] GET /api/ops/usage só para editor", () => {
  it("[RF14] sem login 401, não editor 403; nenhum provedor nem RPC é consultado", async () => {
    expect((await GET(req(null))).status).toBe(401);
    expect((await GET(req(STRANGER))).status).toBe(403);
    expect(fetched).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("[RNF05] painel de uso: dados oficiais e contagem própria", () => {
  it("[RNF05] lê cada provedor com a chave dele e nunca devolve o valor de uma chave", async () => {
    const { res, text, card } = await report();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toMatch(/SEGREDO/);

    // Anthropic: Admin API paginada, centavos → dólares
    const cost = fetched.filter((f) => f.url.host === "api.anthropic.com");
    expect(cost).toHaveLength(2);
    expect(cost[0]!.headers.get("x-api-key")).toBe(KEYS.ANTHROPIC_ADMIN_KEY);
    expect(cost[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(cost[1]!.url.searchParams.get("page")).toBe("p2");
    expect(card("anthropic")).toMatchObject({ status: "ok", official: [{ label: "Custo no mês (oficial)", text: "US$ 17,50" }] });
    expect(card("anthropic").message).toMatch(/saldo de créditos não é exposto/);

    expect(fetched.find((f) => f.url.host === "api.deepgram.com")!.headers.get("authorization")).toBe(`Token ${KEYS.DEEPGRAM_API_KEY}`);
    expect(card("deepgram")).toMatchObject({ status: "ok", official: [{ text: "US$ 187,30" }] });

    expect(fetched.find((f) => f.url.host === "api.apify.com")!.headers.get("authorization")).toBe(`Bearer ${KEYS.APIFY_TOKEN}`);
    expect(card("apify").official[0]).toMatchObject({ used: 2.5, limit: 5 });
    expect(card("apify").official[0]!.text).toContain("renova 2026-11-03");

    expect(fetched.find((f) => f.url.host === "api.tavily.com")!.headers.get("authorization")).toBe(`Bearer ${KEYS.TAVILY_API_KEY}`);
    expect(card("tavily").official).toEqual([
      { label: "Créditos do plano (Researcher)", text: "812 de 1.000", used: 812, limit: 1000 },
      { label: "Créditos desta chave", text: "150", used: 150 },
    ]);

    expect(card("supabase").official[0]).toMatchObject({ text: "100,0 MB de 500 MB", used: 100, limit: 500 });
    expect(card("voyage").status).toBe("sem_api");
    expect(card("vercel").status).toBe("sem_api");
  });

  it("[RNF05] contagem própria soma os modelos por janela e traz o último retrato de limites", async () => {
    const { card, body } = await report();
    expect(body.counted_error).toBeNull();
    const anthropic = card("anthropic");
    expect(anthropic.counted.map((w) => w.janela)).toEqual(["hoje", "mes"]);
    expect(anthropic.counted[0]).toMatchObject({ requests: 12, input_tokens: 1500, output_tokens: 150 });
    expect(anthropic.counted[0]!.cost_usd).toBeCloseTo(0.0017);
    expect(anthropic.ratelimit?.headers).toEqual({ "anthropic-ratelimit-requests-remaining": "3999" });
    expect(card("voyage").counted).toEqual([{ janela: "hoje", requests: 4, input_tokens: 900, output_tokens: 0, units: 0, cost_usd: 0 }]);
    expect(card("tavily").counted[0]).toMatchObject({ janela: "hora", units: 3 });
    expect(card("google_factcheck").counted).toEqual([]);
  });

  it("[RNF05] sem chaves: cartões dizem qual falta e nada é consultado fora", async () => {
    for (const k of Object.keys(KEYS)) vi.stubEnv(k, "");
    const { card } = await report();
    expect(fetched).toHaveLength(0);
    for (const id of ["anthropic", "deepgram", "apify", "tavily"] as const) expect(card(id).status).toBe("sem_chave");
    expect(card("anthropic").message).toMatch(/ANTHROPIC_ADMIN_KEY/);
    expect(card("deepgram").message).toMatch(/DEEPGRAM_API_KEY/);
    expect(card("supabase").status).toBe("ok");
  });

  it("[RNF05] chave recusada, formato inesperado e provedor mudo ficam no cartão dele; os outros seguem", async () => {
    stubFetch(
      providers({
        "api.anthropic.com/v1/organizations/cost_report": () => jsonRes({ error: { type: "permission_error" } }, 403),
        "api.deepgram.com/v1/projects/p1/balances": () => jsonRes({ algo: "diferente" }),
        "api.apify.com/v2/users/me/limits": () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
        "api.tavily.com/usage": () => jsonRes({ detail: "erro interno com SEGREDO" }, 500),
      }),
    );
    const { res, text, card } = await report();
    expect(res.status).toBe(200);
    expect(card("anthropic")).toMatchObject({ status: "sem_permissao", official: [] });
    expect(card("anthropic").message).toMatch(/HTTP 403/);
    expect(card("deepgram")).toMatchObject({ status: "formato" });
    expect(card("apify")).toMatchObject({ status: "erro", message: "sem resposta em 5 s" });
    expect(card("tavily")).toMatchObject({ status: "erro", message: "HTTP 500" });
    // corpo de erro do provedor não vaza
    expect(text).not.toMatch(/SEGREDO/);
    expect(card("supabase").status).toBe("ok");
    expect(card("anthropic").counted).toHaveLength(2);
  });

  it("[RNF05] contagem própria fora do ar: 200 com o aviso e os dados oficiais", async () => {
    useDb({ "rpc:api_usage_summary": () => ({ data: null, error: { message: "function api_usage_summary() does not exist" } }) });
    const { res, body, card } = await report();
    expect(res.status).toBe(200);
    expect(body.counted_error).toMatch(/does not exist/);
    expect(card("anthropic").counted).toEqual([]);
    expect(card("anthropic").status).toBe("ok");
  });

  it("[RNF05] cache de 60 s por instância; ?fresh=1 consulta de novo", async () => {
    await report();
    const n = fetched.length;
    expect(n).toBeGreaterThan(0);
    await report();
    expect(fetched).toHaveLength(n);
    await report(req(EDITOR, "?fresh=1"));
    expect(fetched).toHaveLength(2 * n);
  });
});
