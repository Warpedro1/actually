// Rerank comum às camadas L1/L3: ordena por relevância e corta abaixo do mínimo.
// Se o rerank falhar, cai para a similaridade vetorial com barra alta.
import { FALLBACK_MIN_SIMILARITY } from "../config";
import type { Logger } from "../log";
import { errorFields } from "../log";
import type { RerankFn } from "../rerank";

export interface Ranked<T> {
  item: T;
  relevance: number;
}

export async function rerankFilter<T extends { similarity: number }>(
  query: string,
  items: T[],
  toDoc: (t: T) => string,
  rerank: RerankFn,
  opts: { topK: number; minRelevance: number; layer: string; logger: Logger },
): Promise<Ranked<T>[]> {
  if (!items.length) return [];
  try {
    const hits = await rerank(query, items.map(toDoc), opts.topK);
    return hits
      .filter((h) => h.relevance_score >= opts.minRelevance)
      .slice(0, opts.topK)
      .map((h) => ({ item: items[h.index]!, relevance: h.relevance_score }));
  } catch (err) {
    opts.logger("warn", "rerank_failed", { layer: opts.layer, ...errorFields(err) });
    return items
      .filter((t) => t.similarity >= FALLBACK_MIN_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, opts.topK)
      .map((t) => ({ item: t, relevance: t.similarity }));
  }
}
