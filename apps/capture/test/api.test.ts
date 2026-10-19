import { INGEST_TOKEN_HEADER } from "@actually/db";
import { describe, expect, it, vi } from "vitest";
import { ApiError, IngestClient, SegmentQueue, isRetryableStatus, type CapturedSegment } from "../src/api";

const AGENT = "11111111-1111-4111-8111-111111111111";
const DEBATE = "22222222-2222-4222-8222-222222222222";

const seg = (text: string, t: number): CapturedSegment => ({
  text,
  speaker_label: "S0",
  t_start: t,
  t_end: t + 2,
  captured_at: new Date(1_000_000 + t * 1000).toISOString(),
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** fetch falso: responde por fila de respostas e grava as chamadas. */
function fakeFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    const r = responses.shift();
    if (!r) throw new Error("sem resposta preparada");
    if (r instanceof Error) throw r;
    return r;
  });
  return { fn, calls };
}

function makeQueue(responses: (Response | Error)[]) {
  const f = fakeFetch(responses);
  const client = new IngestClient({ baseUrl: "https://api.test/", token: "tok", fetch: f.fn });
  const delays: number[] = [];
  const queue = new SegmentQueue({
    client,
    sleep: async (ms) => {
      delays.push(ms);
    },
    now: () => 1_000_000 + 5000,
    backoff: { baseMs: 100, maxMs: 1000, jitter: 0 },
  });
  return { queue, calls: f.calls, delays };
}

describe("IngestClient", () => {
  it("envia token no header e valida a resposta", async () => {
    const f = fakeFetch([json(200, { agent_id: AGENT, debate_id: DEBATE })]);
    const c = new IngestClient({ baseUrl: "https://api.test/", token: "segredo", fetch: f.fn });
    const r = await c.register({ debate_slug: "debate-23-10", name: "mac", source: "youtube", role: "primary" });
    expect(r.agent_id).toBe(AGENT);
    expect(f.calls[0]!.url).toBe("https://api.test/api/ingest/register");
    expect((f.calls[0]!.init.headers as Record<string, string>)[INGEST_TOKEN_HEADER]).toBe("segredo");
  });

  it("rejeita request fora do contrato sem chamar a rede", async () => {
    const f = fakeFetch([]);
    const c = new IngestClient({ baseUrl: "https://api.test", token: "t", fetch: f.fn });
    await expect(c.heartbeat({ agent_id: "não-é-uuid" })).rejects.toMatchObject({ retryable: false });
    expect(f.calls).toHaveLength(0);
  });

  it("resposta fora do contrato é erro transitório", async () => {
    const f = fakeFetch([json(200, { ok: true })]);
    const c = new IngestClient({ baseUrl: "https://api.test", token: "t", fetch: f.fn });
    await expect(c.heartbeat({ agent_id: AGENT })).rejects.toMatchObject({ retryable: true });
  });

  it("classifica status HTTP", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});

describe("SegmentQueue", () => {
  it("segura os segmentos até o register e envia em ordem com seq crescente", async () => {
    const { queue, calls } = makeQueue([
      json(200, { status: "accepted", segment_id: 1 }),
      json(200, { status: "accepted", segment_id: 2 }),
      json(200, { status: "accepted", segment_id: 3 }),
    ]);
    queue.enqueue(seg("a", 0));
    queue.enqueue(seg("b", 2));
    queue.enqueue(seg("c", 4));
    expect(calls).toHaveLength(0);
    queue.setAgent(AGENT);
    expect(await queue.drain(1000)).toBe(true);
    expect(calls.map((c) => [c.body.seq, c.body.text])).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ]);
    expect(calls[0]!.body.agent_id).toBe(AGENT);
    expect(queue.stats.accepted).toBe(3);
  });

  it("retry com backoff exponencial no mesmo seq, sem furar a ordem", async () => {
    const { queue, calls, delays } = makeQueue([
      new TypeError("fetch failed"),
      json(503, { error: "indisponível" }),
      json(200, { status: "accepted", segment_id: 1 }),
      json(200, { status: "accepted", segment_id: 2 }),
    ]);
    const retries: number[] = [];
    queue.on("retry", (r) => retries.push(r.seq));
    queue.enqueue(seg("a", 0));
    queue.enqueue(seg("b", 2));
    queue.setAgent(AGENT);
    await queue.drain(1000);
    expect(calls.map((c) => c.body.seq)).toEqual([0, 0, 0, 1]);
    expect(retries).toEqual([0, 0]);
    expect(delays).toEqual([100, 200]);
    expect(queue.stats.retries).toBe(2);
  });

  it("duplicate conta como sucesso (retry de um seq já gravado)", async () => {
    const { queue, calls } = makeQueue([json(200, { status: "duplicate" }), json(200, { status: "accepted", segment_id: 9 })]);
    queue.enqueue(seg("a", 0));
    queue.enqueue(seg("b", 2));
    queue.setAgent(AGENT);
    await queue.drain(1000);
    expect(calls).toHaveLength(2);
    expect(queue.stats.duplicate).toBe(1);
    expect(queue.stats.accepted).toBe(1);
  });

  it("standby é normal: segue enviando os próximos", async () => {
    const { queue, calls } = makeQueue([json(200, { status: "standby" }), json(200, { status: "standby" })]);
    const results: string[] = [];
    queue.on("result", (r) => results.push(r.status));
    queue.enqueue(seg("a", 0));
    queue.enqueue(seg("b", 2));
    queue.setAgent(AGENT);
    await queue.drain(1000);
    expect(results).toEqual(["standby", "standby"]);
    expect(calls).toHaveLength(2);
    expect(queue.size).toBe(0);
  });

  it("erro permanente (400) descarta e não trava a fila", async () => {
    const { queue, calls } = makeQueue([json(400, { error: "inválido" }), json(200, { status: "accepted", segment_id: 2 })]);
    const dropped: number[] = [];
    queue.on("dropped", (r) => dropped.push(r.seq));
    queue.enqueue(seg("a", 0));
    queue.enqueue(seg("b", 2));
    queue.setAgent(AGENT);
    await queue.drain(1000);
    expect(dropped).toEqual([0]);
    expect(calls.map((c) => c.body.seq)).toEqual([0, 1]);
  });

  it("mede latência do fim da fala até a resposta", async () => {
    const { queue } = makeQueue([json(200, { status: "accepted", segment_id: 1 })]);
    queue.enqueue(seg("a", 0)); // captured_at = 1_000_000 ms; now = 1_005_000
    queue.setAgent(AGENT);
    await queue.drain(1000);
    expect(queue.stats.lastLatencyMs).toBe(5000);
  });

  it("drain estoura o tempo se a API não volta", async () => {
    const f = fakeFetch([]);
    const client = new IngestClient({ baseUrl: "https://api.test", token: "t", fetch: f.fn });
    const queue = new SegmentQueue({ client, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    queue.enqueue(seg("a", 0));
    queue.setAgent(AGENT);
    expect(await queue.drain(30)).toBe(false);
    queue.stop();
    expect(queue.size).toBe(1);
  });

  it("ApiError carrega status e retryable", () => {
    const e = new ApiError("x", 503, true);
    expect(e.status).toBe(503);
    expect(e.retryable).toBe(true);
  });
});
