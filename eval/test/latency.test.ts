import { describe, expect, it } from "vitest";
import { editorStats, renderLatencyReport, stageLatency, type AlertRow } from "../src/latency";

const iso = (s: number) => new Date(Date.UTC(2026, 9, 23, 22, 0, 0) + s * 1000).toISOString();

function alert(over: Partial<AlertRow>): AlertRow {
  return {
    id: "a",
    status: "published",
    verdict: "contradito",
    is_repeat: false,
    created_at: iso(0),
    published_at: null,
    reviewed_at: null,
    segment_captured_at: null,
    ...over,
  };
}

describe("stageLatency", () => {
  it("p50/p95 por chave, ignorando valores não numéricos", () => {
    const s = stageLatency([
      { latency_ms: { verify: 1000, retrieve: 300 } },
      { latency_ms: { verify: 3000, note: "x" } },
      { latency_ms: null },
    ]);
    expect(Object.keys(s)).toEqual(["retrieve", "verify"]);
    expect(s.verify).toMatchObject({ n: 2, p50: 2000, max: 3000 });
  });
});

describe("editorStats", () => {
  const alerts = [
    // aprovado após 20 s; fala terminou 4 s antes da criação
    alert({ id: "1", segment_captured_at: iso(-4), created_at: iso(0), reviewed_at: iso(20), published_at: iso(20) }),
    // rejeitado após 40 s
    alert({ id: "2", status: "rejected", created_at: iso(10), reviewed_at: iso(50) }),
    // publicado automaticamente (sem HITL)
    alert({ id: "3", verdict: "impreciso", segment_captured_at: iso(25), created_at: iso(30), published_at: iso(30) }),
    // pendente
    alert({ id: "4", status: "pending_review", created_at: iso(200) }),
    // repetição não conta no volume
    alert({ id: "5", is_repeat: true, created_at: iso(31), published_at: iso(31) }),
  ];
  const ed = editorStats(alerts, new Date(iso(260)));

  it("espera do editor só conta revisados", () => {
    expect(ed.reviewed).toBe(2);
    expect(ed.editor_wait).toMatchObject({ n: 2, p50: 30_000, max: 40_000 });
  });
  it("fim da fala → criado / publicado", () => {
    expect(ed.speech_to_created).toMatchObject({ n: 2, p50: 4500 });
    expect(ed.speech_to_published).toMatchObject({ n: 2, max: 24_000 });
  });
  it("pendentes e volume", () => {
    expect(ed.pending_now).toBe(1);
    expect(ed.oldest_pending_ms).toBe(60_000);
    expect(ed.by_status).toEqual({ published: 3, rejected: 1, pending_review: 1 });
    expect(ed.peak_60s).toBe(3); // 0, 10, 30 dentro de 60 s
    expect(ed.per_minute.max).toBe(3);
  });
  it("renderiza", () => {
    const md = renderLatencyReport("ensaio", stageLatency([]), 0, ed);
    expect(md).toContain("Espera do editor");
    expect(md).toContain("Pendentes agora: 1");
  });
});
