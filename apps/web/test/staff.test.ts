import type { CaptureAgent, CaptureMachine } from "@actually/db";
import { describe, expect, it } from "vitest";
import { isoToLocalInput, localInputToIso } from "@/lib/format";
import { audioPercent, machineOnline, machineWarnings, silenceSeconds, suggestStartAt } from "@/lib/staff/machines";
import { countByPerson, latencyStats, percentile } from "@/lib/staff/stats";

const NOW = Date.parse("2026-10-24T00:00:00.000Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

function machine(over: Partial<CaptureMachine> = {}, reported: CaptureMachine["reported"] = { state: "running" }): CaptureMachine {
  return {
    id: "m1",
    name: "notebook",
    platform: "linux",
    version: "0.1.0",
    desired: { state: "running", debate_slug: "d", source: "youtube", url: "u", role: "primary" },
    reported,
    last_seen: ago(2),
    desired_updated_at: ago(100),
    desired_updated_by: null,
    created_at: ago(1000),
    ...over,
  };
}

const agent = (active: boolean): CaptureAgent => ({
  id: "a1",
  debate_id: "d",
  name: "notebook",
  source: "youtube",
  role: "primary",
  active,
  last_heartbeat: ago(1),
  created_at: ago(500),
});

describe("máquinas de captura", () => {
  it("online só com contato nos últimos 10 s", () => {
    expect(machineOnline({ last_seen: ago(9) }, NOW)).toBe(true);
    expect(machineOnline({ last_seen: ago(11) }, NOW)).toBe(false);
    expect(machineOnline({ last_seen: null }, NOW)).toBe(false);
  });

  it("alerta forte quando a máquina ATIVA fica offline", () => {
    const m = machine({ last_seen: ago(30) }, { state: "running", agent_id: "a1" });
    const w = machineWarnings(m, [agent(true)], NOW, null);
    expect(w[0]).toMatchObject({ tone: "bad" });
    expect(w[0]!.text).toMatch(/ATIVA offline/);
  });

  it("silêncio > 20 s por nível ou por falta de segmento", () => {
    const bySeg = machine({}, { state: "running", last_segment_at: ago(25), audio_level_db: -20 });
    expect(silenceSeconds(bySeg, NOW, null)).toBe(25);
    expect(machineWarnings(bySeg, [], NOW, null).some((x) => /silêncio/.test(x.text))).toBe(true);

    const byLevel = machine({}, { state: "running", last_segment_at: ago(2), audio_level_db: -80 });
    expect(machineWarnings(byLevel, [], NOW, NOW - 21_000).some((x) => /silêncio/.test(x.text))).toBe(true);
    expect(machineWarnings(byLevel, [], NOW, NOW - 5_000).some((x) => /silêncio/.test(x.text))).toBe(false);

    const idle = machine({}, { state: "idle" });
    expect(silenceSeconds(idle, NOW, NOW - 60_000)).toBeNull();
  });

  it("start_at sugerido = horário do debate − 15 min", () => {
    expect(suggestStartAt("2026-10-24T00:00:00.000Z")).toBe("2026-10-23T23:45:00.000Z");
    expect(suggestStartAt(null)).toBeNull();
  });

  it("barra de áudio: −60 dB → 0%, 0 dB → 100%", () => {
    expect(audioPercent(-60)).toBe(0);
    expect(audioPercent(-30)).toBe(50);
    expect(audioPercent(0)).toBe(100);
    expect(audioPercent(null)).toBe(0);
  });

  it("datetime-local ↔ ISO no fuso de Brasília", () => {
    expect(localInputToIso("2026-10-23T21:45")).toBe("2026-10-24T00:45:00.000Z");
    expect(isoToLocalInput("2026-10-24T00:45:00.000Z")).toBe("2026-10-23T21:45");
  });
});

describe("estatísticas do admin", () => {
  it("percentis", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.95)).toBeCloseTo(19.5);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("latência por etapa na ordem do pipeline, total por último", () => {
    const s = latencyStats([
      { latency_ms: { verify: 2000, filter: 100, total: 3000 } },
      { latency_ms: { verify: 4000, filter: 300, total: 5000 } },
      { latency_ms: null },
    ]);
    expect(s.map((x) => x.stage)).toEqual(["filter", "verify", "total"]);
    expect(s[0]).toMatchObject({ n: 2, p50: 200 });
  });

  it("contagem por pessoa (neutralidade)", () => {
    const rows = countByPerson(
      [
        { speaker_label: "S0", status: "published", verdict: "contradito" },
        { speaker_label: "S0", status: "pending_review", verdict: "contradito" },
        { speaker_label: "S1", status: "published", verdict: "impreciso" },
        { speaker_label: "S2", status: "rejected", verdict: "impreciso" },
      ],
      { S0: "Lula", S1: "Flávio Bolsonaro" },
    );
    expect(rows).toEqual([
      { who: "Flávio Bolsonaro", published_red: 0, published_yellow: 1, pending: 0, rejected: 0 },
      { who: "Lula", published_red: 1, published_yellow: 0, pending: 1, rejected: 0 },
      { who: "Não mapeado (S2)", published_red: 0, published_yellow: 0, pending: 0, rejected: 1 },
    ]);
  });
});
