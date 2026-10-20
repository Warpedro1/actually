// GET /api/alerts: o fallback do Realtime precisa ser cacheável na CDN (mesma
// resposta para todos) e rápido o bastante para o polling do cliente.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ load: vi.fn(), dbError: null as Error | null, editor: vi.fn() }));

vi.mock("@/lib/server/db", () => ({
  getServiceClient: () => {
    if (state.dbError) throw state.dbError;
    return {};
  },
}));
vi.mock("@/lib/server/alerts", () => ({ loadPublishedAlerts: state.load }));
vi.mock("@/lib/server/editorAuth", () => ({ requireEditor: state.editor }));
vi.mock("@/lib/supabase/browser", () => ({ publicBrowserClient: () => null }));

import { GET } from "@/app/api/alerts/route";
import { POLL_MS } from "@/lib/live/useLiveAlerts";

const payload = { debate: { id: "d", slug: "s", title: "T", status: "live" }, alerts: [], attribution: { show: false, map: {} } };

beforeEach(() => {
  state.load.mockReset();
  state.editor.mockReset();
  state.dbError = null;
});

describe("[RNF06] [RNF07] GET /api/alerts (fallback do Realtime)", () => {
  it("[RNF07] resposta pública com cache curto de CDN (s-maxage) — custo não cresce com espectadores", async () => {
    state.load.mockResolvedValue(payload);
    const res = await GET(new Request("http://x/api/alerts?debate=s&since=2026-10-23T23:00:00.000Z"));
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toMatch(/\bpublic\b/);
    const maxage = Number(/s-maxage=(\d+)/.exec(cc)?.[1]);
    expect(maxage).toBeGreaterThan(0);
    expect(state.load).toHaveBeenCalledWith({}, "s", "2026-10-23T23:00:00.000Z", { includeTest: false });
  });

  it("[RNF06] alerta novo aparece no fallback em ≤ polling + s-maxage (≤ 5 s)", async () => {
    state.load.mockResolvedValue(payload);
    const res = await GET(new Request("http://x/api/alerts?debate=s"));
    const maxage = Number(/s-maxage=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1]);
    expect(POLL_MS + maxage * 1000).toBeLessThanOrEqual(5000);
  });

  it("[RNF06] parâmetros inválidos ⇒ 400; debate inexistente ⇒ 404; sem Supabase ⇒ 503 (sem quebrar)", async () => {
    expect((await GET(new Request("http://x/api/alerts"))).status).toBe(400);
    state.load.mockResolvedValue(null);
    expect((await GET(new Request("http://x/api/alerts?debate=nao-existe"))).status).toBe(404);
    state.dbError = new Error("sem env");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await GET(new Request("http://x/api/alerts?debate=s"))).status).toBe(503);
  });
});

describe("[RNF05] debate de teste na rota pública", () => {
  it("[RNF05] sem preview: o loader é chamado sem incluir teste (debate de teste ⇒ 404 sem cache)", async () => {
    state.load.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/alerts?debate=ensaio"));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.load).toHaveBeenCalledWith({}, "ensaio", undefined, { includeTest: false });
    expect(state.editor).not.toHaveBeenCalled();
  });

  it("[RNF05] preview=1 sem editor ⇒ recusado antes de tocar no banco", async () => {
    state.editor.mockResolvedValue({ ok: false, response: Response.json({ error: "faça login" }, { status: 401, headers: { "Cache-Control": "no-store" } }) });
    const res = await GET(new Request("http://x/api/alerts?debate=ensaio&preview=1"));
    expect(res.status).toBe(401);
    expect(state.load).not.toHaveBeenCalled();
  });

  it("[RNF05] preview=1 com editor ⇒ inclui teste e a resposta nunca vai para o cache da CDN", async () => {
    state.editor.mockResolvedValue({ ok: true, userId: "u" });
    state.load.mockResolvedValue(payload);
    const res = await GET(new Request("http://x/api/alerts?debate=ensaio&preview=1", { headers: { authorization: "Bearer t" } }));
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toMatch(/no-store/);
    expect(cc).not.toMatch(/public|s-maxage/);
    expect(state.load).toHaveBeenCalledWith({}, "ensaio", undefined, { includeTest: true });
  });
});
