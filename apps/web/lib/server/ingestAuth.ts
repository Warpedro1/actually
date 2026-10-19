import { createHash, timingSafeEqual } from "node:crypto";
import { INGEST_TOKEN_HEADER } from "@actually/db";
import { jsonError } from "./http";

/**
 * Comparação em tempo constante. Os dois lados passam por SHA-256 antes do
 * timingSafeEqual, então o tempo também não vaza o tamanho do token.
 */
export function tokensMatch(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** null = autorizado; senão, a resposta de erro a devolver. */
export function checkIngestToken(req: Request): Response | null {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    console.error("[ingest] INGEST_TOKEN não configurado — recusando todas as requisições");
    return jsonError(503, "INGEST_TOKEN não configurado no servidor");
  }
  if (!tokensMatch(req.headers.get(INGEST_TOKEN_HEADER), expected)) {
    return jsonError(401, "token de ingestão inválido");
  }
  return null;
}
