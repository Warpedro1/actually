import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHUNK_BYTES } from "../src/audio";
import { DeepgramStream, buildDeepgramUrl, parseDeepgramMessage, selectResend, type WsLike } from "../src/deepgram";

describe("URL do Deepgram", () => {
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
    const ev = parseDeepgramMessage(raw, 100);
    expect(ev).toMatchObject({ type: "results", isFinal: true, speechFinal: true, end: 103.5 });
    if (ev?.type !== "results") throw new Error();
    expect(ev.words).toEqual([
      { text: "O", start: 101.6, end: 101.7, speaker: 0 },
      { text: "desemprego", start: 101.8, end: 102.4, speaker: 0 },
      { text: "caiu.", start: 102.5, end: 103, speaker: null },
    ]);
  });

  it("UtteranceEnd, SpeechStarted e lixo", () => {
    expect(parseDeepgramMessage(JSON.stringify({ type: "UtteranceEnd", last_word_end: 2 }), 10)).toEqual({ type: "utterance_end", lastWordEnd: 12 });
    expect(parseDeepgramMessage(JSON.stringify({ type: "SpeechStarted", timestamp: 1 }), 0)).toEqual({ type: "speech_started", t: 1 });
    expect(parseDeepgramMessage("não é json", 0)).toBeNull();
    expect(parseDeepgramMessage(JSON.stringify({ type: "Outro" }), 0)).toBeNull();
  });
});

describe("selectResend", () => {
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

describe("DeepgramStream", () => {
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
