import { afterEach, describe, expect, it, vi } from "vitest";
import { checkIngestToken, tokensMatch } from "@/lib/server/ingestAuth";

const req = (token?: string) =>
  new Request("http://x/api/ingest/heartbeat", {
    method: "POST",
    headers: token === undefined ? {} : { "x-ingest-token": token },
  });

describe("[RNF05] tokensMatch (tempo constante)", () => {
  it("aceita token idêntico", () => {
    expect(tokensMatch("segredo-123", "segredo-123")).toBe(true);
  });
  it("recusa token diferente, inclusive de outro tamanho", () => {
    expect(tokensMatch("segredo-124", "segredo-123")).toBe(false);
    expect(tokensMatch("segredo", "segredo-123")).toBe(false);
    expect(tokensMatch("segredo-1234567", "segredo-123")).toBe(false);
  });
  it("recusa vazio/ausente", () => {
    expect(tokensMatch("", "x")).toBe(false);
    expect(tokensMatch(null, "x")).toBe(false);
    expect(tokensMatch("x", "")).toBe(false);
  });
});

describe("[RNF05] checkIngestToken", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("503 quando INGEST_TOKEN não está configurado (nunca aceita)", async () => {
    vi.stubEnv("INGEST_TOKEN", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = checkIngestToken(req("qualquer"));
    expect(res?.status).toBe(503);
  });

  it("401 sem header ou com token errado", () => {
    vi.stubEnv("INGEST_TOKEN", "t0k3n");
    expect(checkIngestToken(req())?.status).toBe(401);
    expect(checkIngestToken(req("errado"))?.status).toBe(401);
  });

  it("null (autorizado) com o token certo", () => {
    vi.stubEnv("INGEST_TOKEN", "t0k3n");
    expect(checkIngestToken(req("t0k3n"))).toBeNull();
  });
});
