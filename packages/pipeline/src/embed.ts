// Embeddings Voyage (voyage-3.5, 1024 dims) via fetch.
import { EMBEDDING_DIM, TIMEOUTS_MS, VOYAGE_EMBED_MODEL, VOYAGE_EMBED_URL } from "./config";
import type { UsageMeter } from "./usage";

export type EmbedInputType = "query" | "document";
export type EmbedFn = (texts: string[], inputType: EmbedInputType) => Promise<number[][]>;

interface VoyageEmbedResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { total_tokens?: number };
}

export function voyageEmbed(apiKey: string, fetchImpl: typeof fetch = fetch, usage?: UsageMeter): EmbedFn {
  return async (texts, inputType) => {
    if (!texts.length) return [];
    const res = await fetchImpl(VOYAGE_EMBED_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        input: texts,
        model: VOYAGE_EMBED_MODEL,
        input_type: inputType,
        output_dimension: EMBEDDING_DIM,
      }),
      signal: AbortSignal.timeout(TIMEOUTS_MS.embed),
    });
    usage?.ratelimit("voyage", res.headers);
    if (!res.ok) throw new Error(`voyage embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as VoyageEmbedResponse;
    usage?.record({ provider: "voyage", model: VOYAGE_EMBED_MODEL, requests: 1, input_tokens: json.usage?.total_tokens ?? 0 });
    const out: number[][] = new Array(texts.length);
    for (const d of json.data) out[d.index] = d.embedding;
    for (let i = 0; i < texts.length; i++) {
      const v = out[i];
      if (!v || v.length !== EMBEDDING_DIM) throw new Error(`voyage embeddings: vetor ${i} ausente ou com dimensão errada`);
    }
    return out;
  };
}
