import { INGEST_TOKEN_HEADER } from "@actually/db";
import { describe, expect, it } from "vitest";
import { IngestClient } from "../src/api";
import { probeIngestToken } from "../src/doctor";

const AGENT = "33333333-3333-4333-8333-333333333333";

function clientWith(res: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new IngestClient({
    baseUrl: "https://api.test",
    token: "tok-da-maquina",
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (res instanceof Error) throw res;
      return res;
    },
  });
  return { client, calls };
}

const err = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

describe("[RF13] capture doctor valida o INGEST_TOKEN de verdade", () => {
  it("heartbeat autenticado de um agente aleatório: 404 'agente desconhecido' = token aceito, sem efeito colateral", async () => {
    const { client, calls } = clientWith(err(404, "agente desconhecido — registre de novo"));
    const r = await probeIngestToken(client, AGENT);
    expect(r.level).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test/api/ingest/heartbeat");
    expect((calls[0]!.init.headers as Record<string, string>)[INGEST_TOKEN_HEADER]).toBe("tok-da-maquina");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ agent_id: AGENT });
  });

  it("agent_id padrão é um UUID novo (nunca o de um agente real)", async () => {
    const { client, calls } = clientWith(err(404, "agente desconhecido — registre de novo"));
    await probeIngestToken(client);
    expect(JSON.parse(String(calls[0]!.init.body)).agent_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  it("401 (token errado) é FALHA com mensagem clara", async () => {
    const { client } = clientWith(err(401, "token de ingestão inválido"));
    const r = await probeIngestToken(client, AGENT);
    expect(r.level).toBe("FALHA");
    expect(r.detail).toMatch(/recusado pela API \(HTTP 401\)/);
  });

  it("503 (Vercel sem INGEST_TOKEN ou sem Supabase) é FALHA com mensagem clara", async () => {
    for (const msg of ["INGEST_TOKEN não configurado no servidor", "servidor sem configuração do Supabase (x)"]) {
      const { client } = clientWith(err(503, msg));
      const r = await probeIngestToken(client, AGENT);
      expect(r.level).toBe("FALHA");
      expect(r.detail).toMatch(/HTTP 503/);
      expect(r.detail).toContain(msg);
    }
  });

  it("404 que não é da rota (URL errada), 500 e rede fora também são FALHA", async () => {
    for (const res of [
      new Response("<html>not found</html>", { status: 404 }),
      err(500, "falha no heartbeat: banco fora"),
      new TypeError("fetch failed"),
    ]) {
      const { client } = clientWith(res);
      expect((await probeIngestToken(client, AGENT)).level).toBe("FALHA");
    }
  });
});
