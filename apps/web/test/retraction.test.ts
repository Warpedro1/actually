// Retirada de alerta publicado: quem já está no /ao-vivo vê o card virar
// "Alerta retirado após revisão" (sem afirmação, correção nem fonte); quem
// chega depois não vê nada; o /editor retira com motivo obrigatório.
import type { Alert } from "@actually/db";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlertCard } from "@/components/AlertCard";
import {
  applyAttribution,
  buildFeed,
  mergeAlerts,
  RETRACTED_TEXT,
  retractAlerts,
  toFeedAlert,
  type Attribution,
  type FeedAlert,
} from "@/lib/feed";
import { loadPublishedAlerts } from "@/lib/server/alerts";
import { retractAlert } from "@/lib/staff/retract";
import { argOf, createMockDb, type QueryCall } from "./supabaseMock";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/server/db", () => ({ getServiceClient: () => state.db }));

import { GET } from "@/app/api/alerts/route";

function alert(id: string, over: Partial<Alert> = {}): Alert {
  return {
    id,
    debate_id: "d1",
    claim_id: `c-${id}`,
    verification_id: `v-${id}`,
    verdict: "contradito",
    status: "published",
    claim_text: `afirmação ${id}`,
    summary: `resumo ${id}`,
    correction: `correção ${id}`,
    speaker_label: "S0",
    is_repeat: false,
    repeat_of: null,
    segment_t_end: null,
    created_at: "2026-10-23T23:00:00.000Z",
    published_at: "2026-10-23T23:00:05.000Z",
    reviewed_by: null,
    reviewed_at: null,
    reject_reason: null,
    ...over,
  };
}

const EV = {
  url: "https://ibge.gov.br/x",
  source_name: "IBGE",
  source_tier: 1 as const,
  quote: "trecho da fonte",
  evidence_type: "indicator" as const,
  published_at: null,
};
const shown: Attribution = { show: true, speakers: { S0: "Lula" } };
const fa = (id: string, over: Partial<Alert> = {}): FeedAlert => toFeedAlert(alert(id, over), [EV], shown);

/** Nada do alerta retirado sobra no aviso. */
function expectNeutral(a: FeedAlert | undefined) {
  expect(a?.retracted).toBe(true);
  expect(a).toMatchObject({ claim_text: "", correction: "", summary: "", person: null, speaker_label: null, reject_reason: null });
  expect(a?.evidence).toEqual([]);
}

describe("[RNF06] feed: retirada propagada por retracted_ids", () => {
  const screen = () => [fa("a", { published_at: "2026-10-23T23:01:00.000Z" }), fa("b")];

  it("alerta na tela que aparece em retracted_ids vira aviso neutro, no mesmo lugar", () => {
    const next = mergeAlerts(screen(), [], ["a"]);
    expect(next.map((x) => x.id)).toEqual(["a", "b"]);
    expectNeutral(next[0]);
    expect(next[1]!.retracted).toBeUndefined();
  });

  it("repetição de um alerta retirado também vira aviso", () => {
    const cur = [fa("a"), fa("r", { is_repeat: true, repeat_of: "a", published_at: "2026-10-23T23:09:00.000Z" })];
    const next = mergeAlerts(cur, [], ["a"]);
    expect(next.every((x) => x.retracted)).toBe(true);
  });

  it("quem chega depois não vê nada: retirado que não estava na tela nunca entra", () => {
    const next = mergeAlerts([], [fa("a"), fa("b"), fa("r", { is_repeat: true, repeat_of: "a" })], ["a"]);
    expect(next.map((x) => x.id)).toEqual(["b"]);
  });

  it("retirada é definitiva: resposta antiga da CDN com o alerta publicado não traz o card de volta", () => {
    const retracted = mergeAlerts(screen(), [], ["a"]);
    const stale = mergeAlerts(retracted, [fa("a")], []);
    expectNeutral(stale.find((x) => x.id === "a"));
  });

  it("versão não publicada de um alerta na tela (Realtime) também vira aviso", () => {
    const next = mergeAlerts(screen(), [fa("a", { status: "rejected", reject_reason: "motivo interno" })]);
    expectNeutral(next.find((x) => x.id === "a"));
  });

  it("atribuição nova não devolve o nome ao aviso", () => {
    const next = applyAttribution(retractAlerts(screen(), ["a"]), shown);
    expect(next.find((x) => x.id === "a")!.person).toBeNull();
    expect(next.find((x) => x.id === "b")!.person).toBe("Lula");
  });

  it("buildFeed (servidor) deixa de fora retirados e repetições deles", () => {
    const feed = buildFeed({
      alerts: [alert("b"), alert("r", { is_repeat: true, repeat_of: "a" })],
      evidence: [
        { verification_id: "v-b", ...EV, quote_verified: true },
        { verification_id: "v-r", ...EV, quote_verified: true },
      ],
      attribution: shown,
      retractedIds: ["a"],
    });
    expect(feed.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("[RF05] aviso de retirada não repete a afirmação, a correção nem a fonte", () => {
  it("card do aviso mostra só o texto neutro e o horário", () => {
    const original = fa("a", { claim_text: "O desemprego é de 20%", correction: "É de 6,5% (IBGE)" });
    const [placeholder] = retractAlerts([original], ["a"]);
    const html = renderToStaticMarkup(createElement(AlertCard, { alert: placeholder!, feed: [placeholder!] }));
    expect(html).toContain(RETRACTED_TEXT);
    for (const leaked of ["desemprego", "6,5%", "IBGE", "ibge.gov.br", "trecho da fonte", "Lula", "Contradito"]) {
      expect(html).not.toContain(leaked);
    }
  });
});

function retractionDb(over: { retracted?: string[]; published?: Alert[] } = {}) {
  return createMockDb({
    debates: () => ({ data: { id: "d1", slug: "s", title: "Debate", status: "live", settings: {} }, error: null }),
    alerts: (q) => {
      if (q.ops.some((o) => o.op === "neq")) return { data: (over.retracted ?? []).map((id) => ({ id })), error: null };
      if (q.ops.some((o) => o.op === "in")) return { data: [], error: null };
      return { data: over.published ?? [], error: null };
    },
    speaker_map: () => ({ data: [], error: null }),
    evidence: () => ({
      data: (over.published ?? []).map((a) => ({ verification_id: a.verification_id, ...EV, quote_verified: true })),
      error: null,
    }),
  });
}

const retractedCall = (calls: QueryCall[]) => calls.find((c) => c.table === "alerts" && c.ops.some((o) => o.op === "neq"));

describe("[RNF06] GET /api/alerts devolve retracted_ids", () => {
  beforeEach(() => {
    state.db = null;
  });

  it("retracted_ids ignora o cursor: lista completa do debate, só alertas que estiveram no ar", async () => {
    const mock = retractionDb({ retracted: ["a", "r"], published: [alert("b")] });
    const payload = await loadPublishedAlerts(mock.db as never, "s", "2026-10-23T23:30:00.000Z");
    expect(payload!.retracted_ids).toEqual(["a", "r"]);
    const call = retractedCall(mock.calls)!;
    expect(call.ops).toContainEqual({ op: "eq", args: ["debate_id", "d1"] });
    expect(call.ops).toContainEqual({ op: "neq", args: ["status", "published"] });
    expect(call.ops).toContainEqual({ op: "not", args: ["published_at", "is", null] });
    expect(call.ops.some((o) => o.op === "gte")).toBe(false);
    // Só ids vão para o público.
    expect(argOf(call, "select")).toBe("id");
  });

  it("alerta publicado que é repetição de um retirado não vai no payload", async () => {
    const mock = retractionDb({ retracted: ["a"], published: [alert("b"), alert("r", { is_repeat: true, repeat_of: "a" })] });
    const payload = await loadPublishedAlerts(mock.db as never, "s");
    expect(payload!.alerts.map((x) => x.id)).toEqual(["b"]);
  });

  it("rota: com `since`, a resposta (cacheável) traz retracted_ids", async () => {
    state.db = retractionDb({ retracted: ["a"] }).db;
    const res = await GET(new Request("http://x/api/alerts?debate=s&since=2026-10-23T23:30:00.000Z"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=\d+/);
    const body = (await res.json()) as { retracted_ids: string[]; alerts: unknown[] };
    expect(body.retracted_ids).toEqual(["a"]);
    expect(body.alerts).toEqual([]);
  });
});

describe("[RF08] /editor: Retirar alerta publicado", () => {
  const NOW = () => new Date("2026-10-24T00:10:00.000Z");

  it("grava rejected + motivo + quem/quando, só se ainda estiver publicado", async () => {
    const mock = createMockDb({ alerts: () => ({ data: [{ id: "a" }], error: null }) });
    const res = await retractAlert(mock.db as never, { alertId: "a", userId: "u1", reason: "  fonte não sustenta  " }, NOW);
    expect(res).toEqual({ ok: true });
    const call = mock.calls[0]!;
    expect(argOf(call, "update")).toEqual({
      status: "rejected",
      reject_reason: "fonte não sustenta",
      reviewed_by: "u1",
      reviewed_at: "2026-10-24T00:10:00.000Z",
    });
    expect(call.ops).toContainEqual({ op: "eq", args: ["id", "a"] });
    expect(call.ops).toContainEqual({ op: "eq", args: ["status", "published"] });
  });

  it("motivo é obrigatório (nem chega ao banco)", async () => {
    const mock = createMockDb({ alerts: () => ({ data: [{ id: "a" }], error: null }) });
    const res = await retractAlert(mock.db as never, { alertId: "a", userId: "u1", reason: "   " }, NOW);
    expect(res.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });

  it("já retirado por outra pessoa ou recusado pelo banco ⇒ erro claro", async () => {
    const none = createMockDb({ alerts: () => ({ data: [], error: null }) });
    expect(await retractAlert(none.db as never, { alertId: "a", userId: "u1", reason: "x" }, NOW)).toEqual({
      ok: false,
      error: expect.stringMatching(/já não está publicado/),
    });
    const denied = createMockDb({ alerts: () => ({ data: null, error: { message: "permission denied" } }) });
    expect(await retractAlert(denied.db as never, { alertId: "a", userId: "u1", reason: "x" }, NOW)).toEqual({
      ok: false,
      error: expect.stringMatching(/permission denied/),
    });
  });
});
