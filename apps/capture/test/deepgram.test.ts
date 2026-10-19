import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHUNK_BYTES } from "../src/audio";
import {
  DEFAULT_STT_STALL_MS,
  DeepgramStream,
  buildDeepgramUrl,
  parseDeepgramMessage,
  selectResend,
  speakerLabel,
  type DgEvent,
  type WsLike,
} from "../src/deepgram";

describe("[RF01] URL do Deepgram (pt-BR, diarização)", () => {
  it("leva os parâmetros pedidos", () => {
    const u = new URL(buildDeepgramUrl("nova-3"));
    expect(u.origin + u.pathname).toBe("wss://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      model: "nova-3",
      language: "pt-BR",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      diarize: "true",
      punctuate: "true",
      smart_format: "true",
      interim_results: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      vad_events: "true",
    });
  });
});

describe("parseDeepgramMessage", () => {
  it("Results final com offset da conexão", () => {
    const raw = JSON.stringify({
      type: "Results",
      start: 1.5,
      duration: 2,
      is_final: true,
      speech_final: true,
      channel: {
        alternatives: [
          {
            transcript: "o desemprego caiu",
            words: [
              { word: "o", punctuated_word: "O", start: 1.6, end: 1.7, speaker: 0 },
              { word: "desemprego", start: 1.8, end: 2.4, speaker: 0 },
              { word: "caiu", punctuated_word: "caiu.", start: 2.5, end: 3.0 },
            ],
          },
        ],
      },
    });
    const ev = parseDeepgramMessage(raw, 100, "s2-abcdef");
    expect(ev).toMatchObject({ type: "results", isFinal: true, speechFinal: true, end: 103.5 });
    if (ev?.type !== "results") throw new Error();
    expect(ev.words).toEqual([
      { text: "O", start: 101.6, end: 101.7, speaker: "s2-abcdef:S0" },
      { text: "desemprego", start: 101.8, end: 102.4, speaker: "s2-abcdef:S0" },
      { text: "caiu.", start: 102.5, end: 103, speaker: null },
    ]);
  });

  it("UtteranceEnd, SpeechStarted e lixo", () => {
    expect(parseDeepgramMessage(JSON.stringify({ type: "UtteranceEnd", last_word_end: 2 }), 10, "s1-x")).toEqual({ type: "utterance_end", lastWordEnd: 12 });
    expect(parseDeepgramMessage(JSON.stringify({ type: "SpeechStarted", timestamp: 1 }), 0, "s1-x")).toEqual({ type: "speech_started", t: 1 });
    expect(parseDeepgramMessage("não é json", 0, "s1-x")).toBeNull();
    expect(parseDeepgramMessage(JSON.stringify({ type: "Outro" }), 0, "s1-x")).toBeNull();
  });
});

describe("[RNF09] selectResend (reconexão sem perder áudio)", () => {
  const chunks = [0, 0.1, 0.2, 0.3].map((t) => ({ t, buf: Buffer.alloc(CHUNK_BYTES) }));
  it("começa no pedaço que contém o último final", () => {
    expect(selectResend(chunks, 0.15)).toBe(1);
    expect(selectResend(chunks, 0)).toBe(0);
    expect(selectResend(chunks, 0.4)).toBe(4);
  });
});

class FakeWs extends EventEmitter implements WsLike {
  readyState = 0;
  bufferedAmount = 0;
  sent: (Buffer | string)[] = [];
  send(d: Buffer | string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
  terminate() {
    this.close();
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  message(obj: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(obj)), false);
  }
}

describe("[RNF09] DeepgramStream", () => {
  afterEach(() => vi.useRealTimers());

  it("reconecta, reenvia o áudio não finalizado e corrige o offset", () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const headers: Record<string, string>[] = [];
    const dg = new DeepgramStream({
      apiKey: "k",
      model: "nova-3",
      wsFactory: (_url, h) => {
        headers.push(h);
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
    });
    const events: any[] = [];
    dg.on("event", (e) => events.push(e));
    dg.start();
    expect(headers[0]).toEqual({ Authorization: "Token k" });
    sockets[0]!.open();

    // 1 s de áudio (10 pedaços), final cobrindo até 0,55 s
    for (let i = 0; i < 10; i++) dg.send(Buffer.alloc(CHUNK_BYTES, i), i * 0.1);
    expect(sockets[0]!.sent.filter(Buffer.isBuffer)).toHaveLength(10);
    sockets[0]!.message({ type: "Results", start: 0, duration: 0.55, is_final: true, channel: { alternatives: [{ transcript: "", words: [] }] } });

    sockets[0]!.close();
    expect(dg.isOpen).toBe(false);
    // áudio continua chegando durante a queda
    dg.send(Buffer.alloc(CHUNK_BYTES, 10), 1.0);
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(dg.reconnects).toBe(1);

    // reenvia a partir do pedaço de 0,5 s (contém 0,55) até o 1,0 s
    const resent = sockets[1]!.sent.filter(Buffer.isBuffer) as Buffer[];
    expect(resent.map((b) => b[0])).toEqual([5, 6, 7, 8, 9, 10]);

    // tempos da 2ª conexão voltam à linha da captura (offset 0,5)
    sockets[1]!.message({
      type: "Results",
      start: 0,
      duration: 0.5,
      is_final: true,
      channel: { alternatives: [{ transcript: "x", words: [{ word: "x", start: 0.1, end: 0.2 }] }] },
    });
    const last = events.at(-1);
    expect(last.words[0].start).toBeCloseTo(0.6);
    dg.finish(10);
  });

  it("KeepAlive periódico e CloseStream ao encerrar", async () => {
    vi.useFakeTimers();
    let ws!: FakeWs;
    const dg = new DeepgramStream({ apiKey: "k", model: "nova-3", keepAliveMs: 1000, wsFactory: () => (ws = new FakeWs()) });
    dg.start();
    ws.open();
    vi.advanceTimersByTime(3100);
    expect(ws.sent.filter((s) => s === JSON.stringify({ type: "KeepAlive" }))).toHaveLength(3);
    const p = dg.finish(5000);
    expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "CloseStream" }));
    ws.close();
    await p;
  });

  it("HTTP 400 no handshake cai para o modelo de fallback", () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    const sockets: FakeWs[] = [];
    const dg = new DeepgramStream({
      apiKey: "k",
      model: "nova-3",
      fallbackModel: "nova-2",
      wsFactory: (url) => {
        urls.push(url);
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
    });
    const fallbacks: unknown[] = [];
    dg.on("model_fallback", (f) => fallbacks.push(f));
    dg.on("disconnected", () => {});
    dg.start();
    sockets[0]!.emit("unexpected-response", { destroy() {} }, { statusCode: 400, headers: {}, resume() {} });
    vi.advanceTimersByTime(20_000);
    expect(fallbacks).toHaveLength(1);
    expect(new URL(urls[1]!).searchParams.get("model")).toBe("nova-2");
    void dg.finish(10);
  });

  it("HTTP 401 é fatal (sem reconectar)", () => {
    vi.useFakeTimers();
    const sockets: FakeWs[] = [];
    const dg = new DeepgramStream({ apiKey: "k", model: "nova-3", wsFactory: () => (sockets.push(new FakeWs()), sockets.at(-1)!) });
    const fatal: Error[] = [];
    dg.on("fatal", (e) => fatal.push(e));
    dg.start();
    sockets[0]!.emit("unexpected-response", { destroy() {} }, { statusCode: 401, headers: {}, resume() {} });
    vi.advanceTimersByTime(60_000);
    expect(fatal).toHaveLength(1);
    expect(sockets).toHaveLength(1);
  });
});

/** Results final com uma palavra do speaker `sp` (tempos da conexão). */
function result(sp: number, start = 0) {
  return {
    type: "Results",
    start,
    duration: 0.5,
    is_final: true,
    channel: { alternatives: [{ transcript: "x", words: [{ word: "x", start: start + 0.1, end: start + 0.2, speaker: sp }] }] },
  };
}

function streamWithSockets(opts: { stallTimeoutMs?: number } = {}) {
  const sockets: FakeWs[] = [];
  const dg = new DeepgramStream({
    apiKey: "k",
    model: "nova-3",
    ...opts,
    wsFactory: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
  });
  const events: DgEvent[] = [];
  const disconnects: { reason: string }[] = [];
  dg.on("event", (e) => events.push(e));
  dg.on("disconnected", (d) => disconnects.push(d));
  return { dg, sockets, events, disconnects };
}

const wordSpeaker = (ev: DgEvent | undefined) => (ev?.type === "results" ? ev.words[0]?.speaker : undefined);

describe("[RF09] speaker_label com a sessão do STT", () => {
  afterEach(() => vi.useRealTimers());

  it("rótulo = sessão + speaker", () => {
    expect(speakerLabel("s3-a1b2c3", 0)).toBe("s3-a1b2c3:S0");
  });

  it("após reconexão o mesmo número do Deepgram vira outro rótulo (não herda o speaker_map)", () => {
    vi.useFakeTimers();
    const { dg, sockets, events } = streamWithSockets();
    dg.start();
    sockets[0]!.open();
    const s1 = dg.currentSession;
    expect(s1).toMatch(/^s1-[0-9a-f]{6}$/);
    sockets[0]!.message(result(0));
    const first = wordSpeaker(events.at(-1));
    expect(first).toBe(`${s1}:S0`);

    sockets[0]!.close();
    vi.advanceTimersByTime(20_000);
    sockets[1]!.open();
    sockets[1]!.message(result(0));
    const second = wordSpeaker(events.at(-1));
    expect(dg.currentSession).toMatch(/^s2-[0-9a-f]{6}$/);
    expect(second).toBe(`${dg.currentSession}:S0`);
    expect(second).not.toBe(first);
    expect((second as string).length).toBeLessThanOrEqual(32); // limite de speaker_label no contrato
    void dg.finish(10);
  });

  it("agentes diferentes (failover para o standby) nunca geram o mesmo rótulo", () => {
    const a = streamWithSockets();
    const b = streamWithSockets();
    a.dg.start();
    b.dg.start();
    a.sockets[0]!.open();
    b.sockets[0]!.open();
    a.sockets[0]!.message(result(0));
    b.sockets[0]!.message(result(0));
    expect(wordSpeaker(a.events.at(-1))).not.toBe(wordSpeaker(b.events.at(-1)));
    void a.dg.finish(10);
    void b.dg.finish(10);
  });
});

describe("[RNF09] watchdog do STT (socket meio-aberto)", () => {
  afterEach(() => vi.useRealTimers());

  /** Manda `seconds` de áudio em pedaços de 100 ms, avançando o relógio junto. */
  function stream(dg: DeepgramStream, from: number, seconds: number, onTick?: (t: number) => void) {
    for (let i = 0; i < seconds * 10; i++) {
      const t = from + i / 10;
      dg.send(Buffer.alloc(CHUNK_BYTES, 1), t);
      onTick?.(t);
      vi.advanceTimersByTime(100);
    }
  }

  it("áudio fluindo e nenhuma mensagem do Deepgram ⇒ derruba e reconecta, reenviando o áudio", () => {
    vi.useFakeTimers();
    const { dg, sockets, disconnects } = streamWithSockets();
    dg.start();
    sockets[0]!.open();
    stream(dg, 0, 5, (t) => {
      if (Math.abs(t - 2) < 1e-9) sockets[0]!.message({ type: "Results", start: 0, duration: 2, is_final: true, channel: { alternatives: [{ transcript: "", words: [] }] } });
    });
    expect(disconnects).toHaveLength(0);
    // a partir daqui o socket aceita áudio mas não responde mais
    stream(dg, 5, DEFAULT_STT_STALL_MS / 1000 + 2);
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]!.reason).toMatch(/sem resposta/);
    expect(sockets[0]!.readyState).toBe(3); // terminate()
    vi.advanceTimersByTime(20_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    // reenvia a partir do último final (2 s), não perde a fala do período mudo
    const resent = sockets[1]!.sent.filter(Buffer.isBuffer);
    expect(resent.length).toBeGreaterThanOrEqual(DEFAULT_STT_STALL_MS / 100);
    void dg.finish(10);
  });

  it("resultados (mesmo vazios) chegando ⇒ não derruba", () => {
    vi.useFakeTimers();
    const { dg, sockets, disconnects } = streamWithSockets();
    dg.start();
    sockets[0]!.open();
    stream(dg, 0, 60, (t) => {
      if (Math.round(t * 10) % 10 === 0) sockets[0]!.message({ type: "Results", start: 0, duration: 1, is_final: false, channel: { alternatives: [{ transcript: "", words: [] }] } });
    });
    expect(disconnects).toHaveLength(0);
    void dg.finish(10);
  });

  it("fonte parada (sem áudio) não conta; ao voltar o áudio, a espera recomeça do zero", () => {
    vi.useFakeTimers();
    const { dg, sockets, disconnects } = streamWithSockets({ stallTimeoutMs: 10_000 });
    dg.start();
    sockets[0]!.open();
    stream(dg, 0, 3, (t) => {
      if (Math.abs(t - 2.9) < 1e-9) sockets[0]!.message({ type: "Results", start: 0, duration: 2.9, is_final: true, channel: { alternatives: [{ transcript: "", words: [] }] } });
    });
    // fonte reiniciando: 60 s sem áudio e sem mensagens (só KeepAlive)
    vi.advanceTimersByTime(60_000);
    expect(disconnects).toHaveLength(0);
    // áudio volta; o Deepgram responde em 1 s
    stream(dg, 3, 1);
    sockets[0]!.message({ type: "Results", start: 3, duration: 1, is_final: false, channel: { alternatives: [{ transcript: "", words: [] }] } });
    stream(dg, 4, 5);
    expect(disconnects).toHaveLength(0);
    void dg.finish(10);
  });
});
