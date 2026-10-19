import type { MachineDesired } from "@actually/db";
import { describe, expect, it } from "vitest";
import { clockOffset, idleReportedState, reconcile, specFromDesired, specKey, type ReconcileInput } from "../src/reconcile";

const T = Date.parse("2026-10-23T21:00:00Z");

const yt: MachineDesired = {
  state: "running",
  debate_slug: "debate-23-10",
  source: "youtube",
  url: "https://youtu.be/live",
  role: "primary",
};

function input(desired: MachineDesired | null, over: Partial<ReconcileInput> = {}): ReconcileInput {
  return { desired, now: T, runningKey: null, completedKey: null, retryAt: null, ...over };
}

function keyOf(d: MachineDesired): string {
  const r = specFromDesired(d);
  if ("error" in r) throw new Error(r.error);
  return specKey(r.spec);
}

describe("[RF13] reconcile (daemon remoto)", () => {
  it("sem desejado conhecido não mexe em nada", () => {
    expect(reconcile(input(null))).toEqual({ action: "idle" });
    expect(reconcile(input(null, { runningKey: "x" }))).toEqual({ action: "keep" });
  });

  it("running ⇒ start com a config do desejado", () => {
    const d = reconcile(input(yt));
    expect(d).toMatchObject({ action: "start", spec: { debate_slug: "debate-23-10", role: "primary" } });
    if (d.action !== "start") throw new Error();
    expect(d.spec.source).toEqual({ kind: "youtube", url: "https://youtu.be/live", format: "bestaudio/best" });
  });

  it("running com a mesma config ⇒ keep", () => {
    expect(reconcile(input(yt, { runningKey: keyOf(yt) }))).toEqual({ action: "keep" });
  });

  it("desejado mudou ⇒ restart com a nova config", () => {
    const standby: MachineDesired = { ...yt, source: "device", device: ":1", role: "standby", url: undefined };
    const d = reconcile(input(standby, { runningKey: keyOf(yt) }));
    expect(d).toMatchObject({ action: "restart", spec: { role: "standby", source: { kind: "device", device: ":1" } } });
  });

  it("stopped ⇒ stop se rodando, idle se não", () => {
    expect(reconcile(input({ state: "stopped" }, { runningKey: keyOf(yt) }))).toMatchObject({ action: "stop" });
    expect(reconcile(input({ state: "stopped" }))).toEqual({ action: "idle" });
  });

  it("start_at no futuro ⇒ espera; chegou a hora ⇒ start", () => {
    const d = { ...yt, start_at: "2026-10-23T21:30:00Z" };
    expect(reconcile(input(d))).toEqual({ action: "wait", until: Date.parse("2026-10-23T21:30:00Z") });
    expect(reconcile(input(d, { now: Date.parse("2026-10-23T21:30:00Z") }))).toMatchObject({ action: "start" });
  });

  it("start_at adiado enquanto roda ⇒ para e espera", () => {
    const d = { ...yt, start_at: "2026-10-23T22:00:00Z" };
    expect(reconcile(input(d, { runningKey: keyOf(d) }))).toMatchObject({ action: "stop" });
  });

  it("stop_at atingido ⇒ stop (e não sobe de novo)", () => {
    const d = { ...yt, stop_at: "2026-10-23T20:59:59Z" };
    expect(reconcile(input(d, { runningKey: keyOf(d) }))).toEqual({ action: "stop", reason: "stop_at atingido" });
    expect(reconcile(input(d))).toEqual({ action: "idle" });
    expect(reconcile(input({ ...yt, stop_at: "2026-10-23T23:00:00Z" }))).toMatchObject({ action: "start" });
  });

  it("stop_at atingido depois que o comando chegou ⇒ fim normal do horário (idle, sem erro)", () => {
    const d = { ...yt, stop_at: "2026-10-23T20:59:59Z" };
    const r = reconcile(input(d, { desiredSince: Date.parse("2026-10-23T19:00:00Z") }));
    expect(r).toEqual({ action: "idle" });
    expect(idleReportedState(r, null)).toBe("idle");
  });

  it("comando que chega com stop_at já vencido ⇒ erro visível, nunca no-op silencioso", () => {
    // ex.: "Iniciar agora" com o stop_at do ensaio de ontem
    const d = { ...yt, stop_at: "2026-10-22T21:00:00Z" };
    const r = reconcile(input(d, { desiredSince: T - 2000 }));
    expect(r).toMatchObject({ action: "invalid", error: expect.stringMatching(/stop_at já tinha passado/) });
    expect(idleReportedState(r, null)).toBe("error");
    // rodando, o stop_at vencido continua parando
    expect(reconcile(input(d, { runningKey: keyOf(d), desiredSince: T - 2000 }))).toEqual({ action: "stop", reason: "stop_at atingido" });
  });

  it("stop_at antes do start_at ⇒ inválido (ou stop se rodando)", () => {
    const d = { ...yt, start_at: "2026-10-23T22:00:00Z", stop_at: "2026-10-23T21:30:00Z" };
    expect(reconcile(input(d))).toMatchObject({ action: "invalid", error: expect.stringMatching(/não é depois do start_at/) });
    expect(reconcile(input(d, { runningKey: keyOf(d) }))).toMatchObject({ action: "stop" });
  });

  it("após falha respeita o backoff", () => {
    expect(reconcile(input(yt, { retryAt: T + 5000 }))).toEqual({ action: "backoff", until: T + 5000 });
    expect(reconcile(input(yt, { retryAt: T - 1 }))).toMatchObject({ action: "start" });
  });

  it("replay de arquivo que terminou não recomeça sozinho", () => {
    const file: MachineDesired = { state: "running", debate_slug: "ensaio", source: "file", url: "/dados/ontem.mp4" };
    expect(reconcile(input(file))).toMatchObject({ action: "start", spec: { source: { kind: "file", path: "/dados/ontem.mp4", realtime: true } } });
    expect(reconcile(input(file, { completedKey: keyOf(file) }))).toEqual({ action: "completed" });
  });

  it("config inválida ⇒ invalid (ou stop se rodando)", () => {
    const bad: MachineDesired = { state: "running", debate_slug: "d", source: "youtube" };
    expect(reconcile(input(bad))).toMatchObject({ action: "invalid", error: expect.stringMatching(/--url/) });
    expect(reconcile(input({ state: "running", source: "device", device: ":0" }))).toMatchObject({ action: "invalid" });
    expect(reconcile(input(bad, { runningKey: keyOf(yt) }))).toMatchObject({ action: "stop" });
  });

  it("role padrão é primary", () => {
    const r = specFromDesired({ state: "running", debate_slug: "d", source: "device", device: ":0" });
    expect(r).toMatchObject({ spec: { role: "primary" } });
  });
});

describe("[RF13] [RNF09] estado reportado e relógio", () => {
  it("mapeia decisões sem runner", () => {
    expect(idleReportedState({ action: "wait", until: 1 }, null)).toBe("waiting_start");
    expect(idleReportedState({ action: "backoff", until: 1 }, "x")).toBe("error");
    expect(idleReportedState({ action: "invalid", error: "x" }, null)).toBe("error");
    expect(idleReportedState({ action: "idle" }, null)).toBe("idle");
    expect(idleReportedState({ action: "idle" }, "falhou")).toBe("error");
    expect(idleReportedState({ action: "completed" }, null)).toBe("idle");
  });

  it("offset do relógio pelo meio da requisição", () => {
    // local enviou em 1000 e recebeu em 1200; servidor dizia 6100 ⇒ servidor está 5000 ms à frente
    expect(clockOffset(new Date(6100).toISOString(), 1000, 1200)).toBe(5000);
    expect(clockOffset("lixo", 0, 0)).toBe(0);
  });
});
