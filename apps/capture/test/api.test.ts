import { DEFAULT_SETTINGS, INGEST_TOKEN_HEADER } from "@actually/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  HEARTBEAT_MAX_IN_FLIGHT,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  HeartbeatLoop,
  IngestClient,
  MIN_FAILOVER_AFTER_S,
  SegmentQueue,
  isRetryableStatus,
  type CapturedSegment,
} from "../src/api";

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

describe("[RNF09] [RNF08] [RF12] SegmentQueue (retry, duplicate, standby)", () => {
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

const accepted = (id: number) => json(200, { status: "accepted", segment_id: id });
const standby = () => json(200, { status: "standby" });

describe("[RF12] segmento recusado como standby nunca é reenviado (sem 'Repetido' falso na troca de ativo)", () => {
  it("virar o ativo depois não reenvia a fala que voltou standby: o outro agente já a entregou", async () => {
    // a e b chegam enquanto outro agente é o ativo; c, depois da troca
    const { queue, calls } = makeQueue([standby(), standby(), accepted(1)]);
    queue.enqueue(seg("a", 0));
    queue.enqueue(seg("b", 2));
    queue.setAgent(AGENT);
    await queue.drain(1000);
    expect(queue.size).toBe(0);
    queue.enqueue(seg("c", 4));
    expect(await queue.drain(1000)).toBe(true);
    // cada seq vai uma única vez: a fala recusada como standby não volta para a API
    expect(calls.map((c) => [c.body.seq, c.body.text])).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ]);
    expect(queue.stats).toMatchObject({ standby: 2, accepted: 1, pending: 0 });
    expect(Object.keys(queue.stats)).not.toContain("replayed");
    expect("replayStandby" in queue).toBe(false);
  });
});

describe("[RF12] heartbeat (cabe na menor janela de failover; beat lento não segura os outros; parar libera o ativo)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("perder um beat inteiro ainda deixa sinal dentro da menor janela de failover que o /admin aceita", () => {
    expect(MIN_FAILOVER_AFTER_S).toBeLessThanOrEqual(DEFAULT_SETTINGS.failover_after_s);
    // pior caso sem registro no banco com a API respondendo: um beat perdido + o próximo tick
    expect(2 * HEARTBEAT_MS).toBeLessThan(MIN_FAILOVER_AFTER_S * 1000);
    // o teto de beats em voo nunca pula um tick enquanto o prazo é respeitado
    expect(HEARTBEAT_TIMEOUT_MS).toBeLessThan(HEARTBEAT_MAX_IN_FLIGHT * HEARTBEAT_MS);
    expect(HEARTBEAT_TIMEOUT_MS).toBeLessThan(MIN_FAILOVER_AFTER_S * 1000);
  });

  it("IngestClient.heartbeat aplica o prazo por chamada (beat travado não fica 15 s em voo)", async () => {
    const c = new IngestClient({
      baseUrl: "https://api.test",
      token: "t",
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const t0 = Date.now();
    await expect(c.heartbeat({ agent_id: AGENT }, { timeoutMs: 30 })).rejects.toMatchObject({ retryable: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  function pendingClient() {
    const pending: { resolve: (v: { active: boolean }) => void; reject: (e: Error) => void }[] = [];
    const timeouts: (number | undefined)[] = [];
    const client = {
      heartbeat: vi.fn((_req: { agent_id: string }, o?: { timeoutMs?: number }) => {
        timeouts.push(o?.timeoutMs);
        return new Promise<{ active: boolean }>((resolve, reject) => pending.push({ resolve, reject }));
      }),
    };
    return { client, pending, timeouts };
  }

  it("um beat em voo não segura o próximo: sai um por HEARTBEAT_MS, com HEARTBEAT_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const { client, pending, timeouts } = pendingClient();
    const hb = new HeartbeatLoop({ client, agentId: AGENT });
    hb.start();
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    // o 1º trava (API lenta): os seguintes saem no horário mesmo assim
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.heartbeat).toHaveBeenCalledTimes(3);
    expect(timeouts).toEqual([HEARTBEAT_TIMEOUT_MS, HEARTBEAT_TIMEOUT_MS, HEARTBEAT_TIMEOUT_MS]);
    // fetch que ignora o abort: o teto de beats em voo segura a pilha
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5);
    expect(client.heartbeat).toHaveBeenCalledTimes(HEARTBEAT_MAX_IN_FLIGHT);
    pending[0]!.resolve({ active: true });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(client.heartbeat).toHaveBeenCalledTimes(HEARTBEAT_MAX_IN_FLIGHT + 1);
    hb.stop();
  });

  it("vale o beat mais novo: resposta (ou falha) atrasada de um beat velho é ignorada", async () => {
    vi.useFakeTimers();
    const { client, pending } = pendingClient();
    const hb = new HeartbeatLoop({ client, agentId: AGENT });
    const events: string[] = [];
    hb.on("beat", (r) => events.push(r.active ? "ativo" : "standby"));
    hb.on("fail", (e) => events.push(`falha:${e.message}`));
    hb.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(pending).toHaveLength(3);
    pending[1]!.resolve({ active: true }); // beat 2 chega primeiro
    await vi.advanceTimersByTimeAsync(0);
    pending[0]!.resolve({ active: false }); // beat 1, atrasado: o banco já viu o 2
    pending[2]!.reject(new Error("rede")); // beat 3 falha depois: vale (é o mais novo)
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["ativo", "falha:rede"]);
    hb.stop();
  });

  it("stop() para de vez e ignora o que ainda estava em voo", async () => {
    vi.useFakeTimers();
    const { client, pending } = pendingClient();
    const hb = new HeartbeatLoop({ client, agentId: AGENT });
    const beats: boolean[] = [];
    hb.on("beat", (r) => beats.push(r.active));
    hb.start();
    pending[0]!.resolve({ active: true });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(beats).toEqual([true]);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);

    // encerrando: para de mandar e ignora a resposta que ainda estava em voo
    hb.stop();
    pending[1]!.resolve({ active: true });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5);
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    expect(beats).toEqual([true]);
    hb.start(); // não ressuscita
    expect(client.heartbeat).toHaveBeenCalledTimes(2);
  });

  it("falha de heartbeat vira evento, não exceção", async () => {
    const client = { heartbeat: vi.fn(async () => Promise.reject(new ApiError("rede", null, true))) };
    const hb = new HeartbeatLoop({ client, agentId: AGENT, intervalMs: 60_000 });
    const fails: string[] = [];
    hb.on("fail", (e) => fails.push(e.message));
    hb.start();
    await vi.waitFor(() => expect(fails).toEqual(["rede"]));
    hb.stop();
  });
});
