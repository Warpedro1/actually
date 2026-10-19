// Embeddings Voyage (voyage-3.5, 1024 dimensões, input_type=document).
// Lotes de até 64 textos e ~60k tokens estimados; retry com backoff no 429/5xx
// (via fetchWithRetry) e pausa entre lotes para não estourar o limite de taxa.
import { EMBEDDING_DIM } from "@actually/db";
import { fetchJson } from "./http";
import { estimateTokens } from "./text";

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
export const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? "voyage-3.5";
const MAX_BATCH = 64; // a API aceita até 128 entradas
const MAX_BATCH_TOKENS = 60_000;
const PAUSE_MS = Number(process.env.VOYAGE_PAUSE_MS ?? 300);

export function hasEmbeddingKey(): boolean {
  return Boolean(process.env.VOYAGE_API_KEY);
}

interface VoyageResponse {
  data?: { embedding: number[]; index: number }[];
  usage?: { total_tokens?: number };
}

/** Agrupa índices em lotes respeitando quantidade e tokens estimados. */
export function planBatches(texts: string[], maxItems = MAX_BATCH, maxTokens = MAX_BATCH_TOKENS): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  let tok = 0;
  texts.forEach((t, i) => {
    const n = estimateTokens(t);
    if (cur.length && (cur.length >= maxItems || tok + n > maxTokens)) {
      batches.push(cur);
      cur = [];
      tok = 0;
    }
    cur.push(i);
    tok += n;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

export async function embedDocuments(texts: string[], log?: (...a: unknown[]) => void): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY ausente");
  const out = new Array<number[]>(texts.length);
  const batches = planBatches(texts);
  for (const [bi, idxs] of batches.entries()) {
    const res = await fetchJson<VoyageResponse>(VOYAGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: idxs.map((i) => texts[i]),
        model: VOYAGE_MODEL,
        input_type: "document",
        output_dimension: EMBEDDING_DIM,
      }),
      timeoutMs: 120_000,
      retries: 5,
    });
    for (const d of res.data ?? []) {
      if (d.embedding.length !== EMBEDDING_DIM) {
        throw new Error(`embedding com ${d.embedding.length} dimensões (esperado ${EMBEDDING_DIM})`);
      }
      out[idxs[d.index]!] = d.embedding;
    }
    log?.(`  embeddings: lote ${bi + 1}/${batches.length} (${idxs.length} textos, ${res.usage?.total_tokens ?? "?"} tokens)`);
    if (bi < batches.length - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  const missing = out.findIndex((e) => !e);
  if (missing >= 0) throw new Error(`Voyage não devolveu embedding para o texto ${missing}`);
  return out;
}
