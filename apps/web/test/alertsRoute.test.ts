// GET /api/alerts: o fallback do Realtime precisa ser cacheável na CDN (mesma
// resposta para todos) e rápido o bastante para o polling do cliente.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ load: vi.fn(), dbError: null as Error | null }));

vi.mock("@/lib/server/db", () => ({
  getServiceClient: () => {
    if (state.dbError) throw state.dbError;
    return {};
  },
}));
vi.mock("@/lib/server/alerts", () => ({ loadPublishedAlerts: state.load }));
vi.mock("@/lib/supabase/browser", () => ({ publicBrowserClient: () => null }));

import { GET } from "@/app/api/alerts/route";
import { POLL_MS } from "@/lib/live/useLiveAlerts";

const payload = { debate: { id: "d", slug: "s", title: "T", status: "live" }, alerts: [], attribution: { show: false, map: {} } };

beforeEach(() => {
  state.load.mockReset();
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
    expect(state.load).toHaveBeenCalledWith({}, "s", "2026-10-23T23:00:00.000Z");
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
