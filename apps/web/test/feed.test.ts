import type { Alert } from "@actually/db";
import { describe, expect, it } from "vitest";
import {
  applyAttribution,
  attributionFrom,
  attributionText,
  buildFeed,
  latestPublishedAt,
  mergeAlerts,
  NEUTRAL_ATTRIBUTION,
  repeatText,
  resolvePerson,
  toFeedAlert,
  type Attribution,
  type FeedAlert,
} from "@/lib/feed";
import { captureStateFrom, loadPublishedAlerts } from "@/lib/server/alerts";
import { youtubeEmbedUrl, youtubeVideoId } from "@/lib/youtube";
import { argOf, createMockDb } from "./supabaseMock";

function alert(id: string, over: Partial<Alert> = {}): Alert {
  return {
    id,
    debate_id: "d1",
    claim_id: `c-${id}`,
    verification_id: `v-${id}`,
    verdict: "contradito",
    status: "published",
    claim_text: `afirmação ${id}`,
    summary: "resumo",
    correction: "correção",
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
  quote: "trecho",
  evidence_type: "indicator" as const,
  published_at: null,
};
const hidden: Attribution = { show: false, speakers: { S0: "Lula", S1: "Flávio Bolsonaro" } };
const shown: Attribution = { show: true, speakers: { S0: "Lula", S1: "Flávio Bolsonaro", S9: "Outro" } };
const fa = (id: string, over: Partial<Alert> = {}, attr = hidden): FeedAlert => toFeedAlert(alert(id, over), [EV], attr);

describe("[RF09] atribuição condicional", () => {
  it("sem show_attribution nunca nomeia, mesmo com speaker mapeado", () => {
    expect(resolvePerson("S0", hidden)).toBeNull();
    expect(attributionText(fa("a"))).toBe(NEUTRAL_ATTRIBUTION);
  });
  it("com show_attribution nomeia só speaker mapeado", () => {
    expect(resolvePerson("S0", shown)).toBe("Lula");
    expect(resolvePerson("S7", shown)).toBeNull();
    expect(resolvePerson(null, shown)).toBeNull();
  });
  it('"Outro" nunca é exibido como nome', () => {
    expect(resolvePerson("S9", shown)).toBeNull();
  });
  it("attributionFrom monta a partir de settings + speaker_map", () => {
    const a = attributionFrom({ show_attribution: true }, [{ speaker_label: "S1", person: "Flávio Bolsonaro" }]);
    expect(resolvePerson("S1", a)).toBe("Flávio Bolsonaro");
  });
  it("applyAttribution reaplica quando o mapeamento muda", () => {
    const list = [fa("a"), fa("b", { speaker_label: "S1" })];
    const named = applyAttribution(list, shown);
    expect(named.map((x) => x.person)).toEqual(["Lula", "Flávio Bolsonaro"]);
    expect(applyAttribution(named, hidden).map((x) => x.person)).toEqual([null, null]);
  });
});

describe("[RNF06] mergeAlerts (Realtime + polling sem duplicar)", () => {
  it("deduplica por id e ordena do mais novo para o mais antigo", () => {
    const a = fa("a", { published_at: "2026-10-23T23:00:00.000Z" });
    const b = fa("b", { published_at: "2026-10-23T23:05:00.000Z" });
    const c = fa("c", { published_at: "2026-10-23T23:02:00.000Z" });
    const merged = mergeAlerts([a, b], [c, a, b]);
    expect(merged.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
  it("versão nova vence, mas não perde evidência já carregada", () => {
    const a = fa("a");
    const updated = { ...a, correction: "nova correção", evidence: [] };
    const [m] = mergeAlerts([a], [updated]);
    expect(m!.correction).toBe("nova correção");
    expect(m!.evidence).toHaveLength(1);
  });
  it("descarta o que não está publicado", () => {
    const merged = mergeAlerts([], [fa("a", { status: "pending_review" }), fa("b")]);
    expect(merged.map((x) => x.id)).toEqual(["b"]);
  });
  it("empate de horário é estável (created_at, depois id)", () => {
    const t = "2026-10-23T23:00:00.000Z";
    const merged = mergeAlerts([], [fa("a", { published_at: t }), fa("b", { published_at: t })]);
    expect(merged.map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("latestPublishedAt é o cursor do polling", () => {
    expect(latestPublishedAt([fa("a", { published_at: "2026-10-23T23:01:00.000Z" }), fa("b")])).toBe(
      "2026-10-23T23:01:00.000Z",
    );
    expect(latestPublishedAt([])).toBeNull();
  });
});

describe("[RF06] repetição", () => {
  it("mostra o horário (Brasília) da verificação original", () => {
    const r = toFeedAlert(alert("r", { is_repeat: true, repeat_of: "a" }), [EV], hidden, "2026-10-24T00:14:00.000Z");
    expect(repeatText(r)).toBe("Repetido — já verificado às 21:14");
  });
  it("usa o original presente no feed quando o horário não veio", () => {
    const orig = fa("a", { created_at: "2026-10-24T00:20:00.000Z" });
    const r = fa("r", { is_repeat: true, repeat_of: "a" });
    expect(repeatText(r, [orig])).toBe("Repetido — já verificado às 21:20");
  });
  it("não repetido → null", () => {
    expect(repeatText(fa("a"))).toBeNull();
  });
});

describe("buildFeed", () => {
  it("só exibe evidência verificada; alerta sem fonte verificada não aparece", () => {
    const feed = buildFeed({
      alerts: [alert("a"), alert("b", { published_at: "2026-10-23T23:09:00.000Z" })],
      evidence: [
        { verification_id: "v-a", ...EV, quote_verified: true },
        { verification_id: "v-a", ...EV, url: "https://x.com/y", source_tier: 4, quote_verified: false },
        { verification_id: "v-b", ...EV, quote_verified: false },
      ],
      attribution: hidden,
    });
    expect(feed.map((x) => x.id)).toEqual(["a"]);
    expect(feed[0]!.evidence).toHaveLength(1);
    expect(feed[0]!.evidence[0]).not.toHaveProperty("quote_verified");
  });
  it("ordena evidências por tier e resolve repetição", () => {
    const feed = buildFeed({
      alerts: [alert("r", { is_repeat: true, repeat_of: "orig" })],
      evidence: [
        { verification_id: "v-r", ...EV, source_name: "Folha", source_tier: 2, quote_verified: true },
        { verification_id: "v-r", ...EV, quote_verified: true },
      ],
      attribution: shown,
      repeatOrigins: { orig: "2026-10-23T23:30:00.000Z" },
    });
    expect(feed[0]!.evidence.map((e) => e.source_tier)).toEqual([1, 2]);
    expect(feed[0]!.repeat_verified_at).toBe("2026-10-23T23:30:00.000Z");
    expect(feed[0]!.person).toBe("Lula");
  });
});

describe("loadPublishedAlerts (GET /api/alerts)", () => {
  it("monta payload com debate, alertas, atribuição e respeita since", async () => {
    const mock = createMockDb({
      debates: () => ({
        data: {
          id: "d1",
          slug: "s",
          title: "Debate",
          status: "live",
          check_mode: "live",
          public_note: "Aviso do editor.",
          settings: { show_attribution: true },
        },
        error: null,
      }),
      alerts: (q) =>
        q.ops.some((o) => o.op === "in" || o.op === "neq")
          ? { data: [], error: null }
          : { data: [alert("a", { speaker_label: "S1" })], error: null },
      speaker_map: () => ({ data: [{ speaker_label: "S1", person: "Flávio Bolsonaro" }], error: null }),
      capture_agents: () => ({ data: [{ id: "ag1" }], error: null }),
      segments: () => ({ data: [{ received_at: "2026-10-23T23:40:00.000Z" }], error: null }),
      evidence: () => ({ data: [{ verification_id: "v-a", ...EV, quote_verified: true }], error: null }),
    });
    const payload = await loadPublishedAlerts(mock.db as never, "s", "2026-10-23T23:00:00.000Z");
    // Status, procedência e aviso vêm em toda resposta: é o que corrige o selo
    // assado no HTML cacheado (ISR) sem request a mais.
    expect(payload!.debate).toEqual({
      id: "d1",
      slug: "s",
      title: "Debate",
      status: "live",
      check_mode: "live",
      public_note: "Aviso do editor.",
    });
    expect(payload!.alerts[0]!.person).toBe("Flávio Bolsonaro");
    expect(payload!.attribution.show).toBe(true);
    const alertsCall = mock.calls.find((c) => c.table === "alerts")!;
    expect(alertsCall.ops).toContainEqual({ op: "gte", args: ["published_at", "2026-10-23T23:00:00.000Z"] });
    expect(alertsCall.ops).toContainEqual({ op: "eq", args: ["status", "published"] });
  });
  it("[RNF05] estado da checagem: agente vivo ⇒ checando agora, e nada da máquina vai para o público", async () => {
    const mock = createMockDb({
      debates: () => ({ data: { id: "d1", slug: "s", title: "Debate", status: "ended", settings: {} }, error: null }),
      alerts: () => ({ data: [], error: null }),
      speaker_map: () => ({ data: [], error: null }),
      capture_agents: () => ({ data: [{ id: "ag1" }], error: null }),
      segments: () => ({ data: [{ received_at: "2026-10-23T23:40:00.000Z" }], error: null }),
    });
    const payload = await loadPublishedAlerts(mock.db as never, "s");
    // Debate encerrado com replay rodando: os dois estados são independentes.
    expect(payload!.capture).toEqual({ state: "running", last_segment_at: "2026-10-23T23:40:00.000Z" });
    // O `reported` da máquina tem trecho de transcrição e caminho de arquivo local:
    // o payload público só pode trazer estado e hora.
    const agentCall = mock.calls.find((c) => c.table === "capture_agents")!;
    expect(argOf(agentCall, "select")).toBe("id");
    expect(agentCall.ops).toContainEqual({ op: "eq", args: ["active", true] });
    expect(agentCall.ops.some((o) => o.op === "gte" && o.args[0] === "last_heartbeat")).toBe(true);
    const segCall = mock.calls.find((c) => c.table === "segments")!;
    expect(argOf(segCall, "select")).toBe("received_at");
    expect(segCall.ops).toContainEqual({ op: "limit", args: [1] });
  });
  it("null para debate inexistente", async () => {
    const mock = createMockDb({ debates: () => ({ data: null, error: null }) });
    expect(await loadPublishedAlerts(mock.db as never, "x")).toBeNull();
  });
  it("[RNF05] debate de teste: null para o público (service role ignora RLS); payload só com includeTest", async () => {
    const handlers = {
      debates: () => ({ data: { id: "d1", slug: "ensaio", title: "Ensaio", status: "live", settings: {}, is_test: true }, error: null }),
      alerts: () => ({ data: [], error: null }),
      speaker_map: () => ({ data: [], error: null }),
      capture_agents: () => ({ data: [], error: null }),
      segments: () => ({ data: [], error: null }),
    };
    const pub = createMockDb(handlers);
    expect(await loadPublishedAlerts(pub.db as never, "ensaio")).toBeNull();
    // nem chega a consultar os alertas
    expect(pub.calls.some((c) => c.table === "alerts")).toBe(false);
    const prev = createMockDb(handlers);
    expect((await loadPublishedAlerts(prev.db as never, "ensaio", undefined, { includeTest: true }))!.debate.slug).toBe("ensaio");
  });
});

describe("[RF10] estado da checagem (captureStateFrom)", () => {
  it("agente vivo manda, independente do status do debate", () => {
    for (const st of ["scheduled", "live", "ended"] as const) {
      expect(captureStateFrom(st, true, null)).toBe("running");
    }
  });
  it("sem agente: encerrado ⇒ encerrada; com fala anterior ⇒ pausada; sem fala ⇒ agendada", () => {
    expect(captureStateFrom("ended", false, "2026-10-23T23:40:00.000Z")).toBe("finished");
    expect(captureStateFrom("ended", false, null)).toBe("finished");
    // debate ao vivo e nada capturando, mas já houve fala: caiu ou foi parada
    expect(captureStateFrom("live", false, "2026-10-23T23:40:00.000Z")).toBe("paused");
    expect(captureStateFrom("live", false, null)).toBe("waiting");
    expect(captureStateFrom("scheduled", false, null)).toBe("waiting");
  });
});

describe("youtube", () => {
  it("extrai o id dos formatos comuns", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ?si=abc",
      "https://m.youtube.com/embed/dQw4w9WgXcQ",
    ]) {
      expect(youtubeVideoId(u)).toBe("dQw4w9WgXcQ");
    }
    expect(youtubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  });
});
