import type { CaptureAgent, CaptureMachine } from "@actually/db";
import { describe, expect, it } from "vitest";
import { isoToLocalInput, localInputToIso } from "@/lib/format";
import { audioPercent, canRemoveAgent, formDebateSlug, machineOnline, machineWarnings, pendingStopAt, silenceSeconds, suggestStartAt, type AgentRow } from "@/lib/staff/machines";
import { countByPerson, latencyStats, percentile } from "@/lib/staff/stats";
import { countedText, ratelimitEntries, usageFraction } from "@/lib/staff/usage";

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

describe("[RF13] máquinas de captura", () => {
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

describe("[RF13] remover agente pelo /admin: botão só para parado e sem falas", () => {
  const row = (beat: string | null, segment_count: number | null): AgentRow => ({ ...agent(false), last_heartbeat: beat, segment_count });
  it("parado há mais de 1 min e sem falas: pode remover", () => {
    expect(canRemoveAgent(row(ago(61), 0), NOW, 10)).toBe(true);
    expect(canRemoveAgent(row(null, 0), NOW, 10)).toBe(true);
  });
  it("deu sinal no último minuto (ou na janela de failover, se maior): não", () => {
    expect(canRemoveAgent(row(ago(59), 0), NOW, 10)).toBe(false);
    expect(canRemoveAgent(row(ago(90), 0), NOW, 120)).toBe(false);
  });
  it("gravou fala, ou contagem indisponível: não", () => {
    expect(canRemoveAgent(row(ago(3600), 52), NOW, 10)).toBe(false);
    expect(canRemoveAgent(row(ago(3600), null), NOW, 10)).toBe(false);
  });
});

describe("[RF13] formulário de comando: stop_at vencido não vai no 'Iniciar agora'", () => {
  it("só pré-preenche/envia stop_at que ainda está no futuro", () => {
    // fim do ensaio de ontem, que fica no desejado depois que a captura para sozinha
    expect(pendingStopAt(ago(24 * 3600), NOW)).toBeNull();
    expect(pendingStopAt(new Date(NOW).toISOString(), NOW)).toBeNull();
    expect(pendingStopAt("2026-10-24T03:00:00.000Z", NOW)).toBe("2026-10-24T03:00:00.000Z");
    expect(pendingStopAt(undefined, NOW)).toBeNull();
    expect(pendingStopAt("lixo", NOW)).toBeNull();
  });
});

describe("[RF13] formulário de comando: debate escolhido", () => {
  const debates = [{ slug: "ensaio" }, { slug: "oficial" }];

  it("[RF13] formulário criado antes da lista de debates usa o que o <select> mostra (não fica vazio)", () => {
    expect(formDebateSlug("", debates, null)).toBe("ensaio");
    expect(formDebateSlug("", [], null)).toBe("");
  });

  it("[RF13] escolha válida vence; senão o debate selecionado no topo; debate apagado da lista não vale", () => {
    expect(formDebateSlug("oficial", debates, "ensaio")).toBe("oficial");
    expect(formDebateSlug("", debates, "oficial")).toBe("oficial");
    expect(formDebateSlug("antigo", debates, null)).toBe("ensaio");
    expect(formDebateSlug("antigo", debates, "sumiu")).toBe("ensaio");
  });
});

describe("[RNF01] [RNF04] estatísticas do admin (latência e neutralidade)", () => {
  it("percentis", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.95)).toBeCloseTo(19.5);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("latência e2e do pipeline (fim da fala → alerta) vem por último", () => {
    const s = latencyStats([{ latency_ms: { e2e: 4200, verify: 2000, extract: 500 } }]);
    expect(s.map((x) => x.stage)).toEqual(["extract", "verify", "e2e"]);
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

describe("[RNF05] painel de uso das APIs: formatação", () => {
  it("[RNF05] barra só com limite positivo; tom sobe em 70% e 90%; nunca passa de 100%", () => {
    expect(usageFraction({ used: 5 })).toBeNull();
    expect(usageFraction({ used: 5, limit: 0 })).toBeNull();
    expect(usageFraction({ used: 50, limit: 100 })).toEqual({ frac: 0.5, tone: "ok" });
    expect(usageFraction({ used: 70, limit: 100 })?.tone).toBe("warn");
    expect(usageFraction({ used: 95, limit: 100 })?.tone).toBe("bad");
    expect(usageFraction({ used: 130, limit: 100 })).toEqual({ frac: 1, tone: "bad" });
  });

  it("[RNF05] cada provedor na sua unidade; custo estimado só quando há", () => {
    const w = { janela: "hoje" as const, requests: 12, input_tokens: 1500, output_tokens: 150, units: 0, cost_usd: 0.0017 };
    expect(countedText("anthropic", w)).toBe("12 chamadas · 1.500 tokens entrada · 150 saída · ≈ US$ 0,0017");
    expect(countedText("voyage", { ...w, output_tokens: 0, cost_usd: 0 })).toBe("12 chamadas · 1.500 tokens");
    expect(countedText("tavily", { ...w, requests: 3, units: 3, input_tokens: 0, output_tokens: 0, cost_usd: 0 })).toBe("3 créditos");
    expect(countedText("apify", { ...w, requests: 2, units: 2, input_tokens: 0, output_tokens: 0, cost_usd: 0 })).toBe("2 execuções");
  });

  it("[RNF05] limites por minuto: restante primeiro, depois limite e reset", () => {
    const keys = ratelimitEntries({
      "anthropic-ratelimit-requests-reset": "x",
      "retry-after": "1",
      "anthropic-ratelimit-requests-limit": "4000",
      "anthropic-ratelimit-requests-remaining": "3999",
    }).map(([k]) => k);
    expect(keys).toEqual([
      "anthropic-ratelimit-requests-remaining",
      "anthropic-ratelimit-requests-limit",
      "anthropic-ratelimit-requests-reset",
      "retry-after",
    ]);
  });
});
