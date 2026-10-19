// Execução do eval sobre o conjunto rotulado. `evaluate` é injetável (testes usam mock).
import type { DebateSettings } from "@actually/db";
import type { ClaimDecision } from "@actually/pipeline";
import type { DecisionRecord, EvalItem } from "./dataset";

export type EvaluateFn = (
  text: string,
  context: string,
  opts?: { settings?: Partial<DebateSettings> },
) => Promise<ClaimDecision[]>;

/** Map com no máximo `limit` promessas em voo, preservando a ordem de entrada. */
export async function mapPool<T, R>(xs: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, xs.length)) }, worker));
  return out;
}

export async function evaluateItem(
  item: EvalItem,
  evaluate: EvaluateFn,
  settings: Partial<DebateSettings>,
  now: () => number = () => performance.now(),
): Promise<DecisionRecord> {
  const t0 = now();
  let decisions: ClaimDecision[] = [];
  let error: string | null = null;
  try {
    decisions = await evaluate(item.text, item.context, { settings });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return {
    item_id: item.id,
    source: item.source,
    speaker: item.speaker,
    topic: item.topic ?? null,
    text: item.text,
    expected: item.expected,
    synthetic: item.synthetic,
    reference_urls: item.reference_urls,
    wall_ms: now() - t0,
    error,
    decisions,
  };
}

export async function runEval(
  items: EvalItem[],
  evaluate: EvaluateFn,
  opts: { concurrency: number; settings: Partial<DebateSettings>; onProgress?: (done: number, total: number, rec: DecisionRecord) => void },
): Promise<DecisionRecord[]> {
  let done = 0;
  return mapPool(items, opts.concurrency, async (item) => {
    const rec = await evaluateItem(item, evaluate, opts.settings);
    opts.onProgress?.(++done, items.length, rec);
    return rec;
  });
}
