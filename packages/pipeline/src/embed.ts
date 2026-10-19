// Embeddings Voyage (voyage-3.5, 1024 dims) via fetch.
import { EMBEDDING_DIM, TIMEOUTS_MS, VOYAGE_EMBED_MODEL, VOYAGE_EMBED_URL } from "./config";

export type EmbedInputType = "query" | "document";
export type EmbedFn = (texts: string[], inputType: EmbedInputType) => Promise<number[][]>;

interface VoyageEmbedResponse {
  data: { embedding: number[]; index: number }[];
}

export function voyageEmbed(apiKey: string, fetchImpl: typeof fetch = fetch): EmbedFn {
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
    if (!res.ok) throw new Error(`voyage embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as VoyageEmbedResponse;
    const out: number[][] = new Array(texts.length);
    for (const d of json.data) out[d.index] = d.embedding;
    for (let i = 0; i < texts.length; i++) {
      const v = out[i];
      if (!v || v.length !== EMBEDDING_DIM) throw new Error(`voyage embeddings: vetor ${i} ausente ou com dimensão errada`);
    }
    return out;
  };
}
