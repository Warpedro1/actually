// Orquestra a recuperação: L1–L3 em paralelo (cada uma com seu timeout);
// L4 (web) só quando nenhuma camada da base trouxe evidência relevante.
import type { KbLayer } from "@actually/db";
import { TIMEOUTS_MS } from "../config";
import type { PipelineDeps } from "../deps";
import { errorFields, withTimeout } from "../log";
import type { EvidenceCandidate, ExtractedClaim, IndicatorComparison, LayerOutcome, RetrievalResult } from "../types";
import { retrieveDocuments } from "./documents";
import { retrieveFactchecks } from "./factchecks";
import { retrieveIndicator } from "./indicators";
import { retrieveWeb } from "./web";

async function runLayer(
  layer: KbLayer,
  deps: PipelineDeps,
  fn: () => Promise<EvidenceCandidate[]>,
): Promise<LayerOutcome> {
  const t0 = deps.now();
  try {
    const candidates = await withTimeout(fn(), TIMEOUTS_MS[layer], `retrieve_${layer}`);
    return { layer, candidates, latency_ms: deps.now() - t0 };
  } catch (err) {
    deps.logger("warn", "layer_failed", { layer, ...errorFields(err) });
    return { layer, candidates: [], latency_ms: deps.now() - t0, error: errorFields(err).error as string };
  }
}

export async function retrieveAll(
  deps: PipelineDeps,
  claim: ExtractedClaim,
  embedding: number[] | null,
): Promise<RetrievalResult> {
  const query = claim.text_normalized;
  let comparison: IndicatorComparison | null = null;

  const tasks: Promise<LayerOutcome>[] = [];
  if (embedding) {
    tasks.push(runLayer("L1", deps, () => retrieveFactchecks(query, embedding, deps.store, deps.rerank, deps.logger)));
  }
  if (claim.indicator) {
    const ref = claim.indicator;
    tasks.push(runLayer("L2", deps, async () => {
      const r = await retrieveIndicator(ref, deps.store);
      comparison = r.comparison;
      return r.candidate ? [r.candidate] : [];
    }));
  }
  if (embedding) {
    tasks.push(runLayer("L3", deps, () => retrieveDocuments(query, embedding, deps.store, deps.rerank, deps.logger)));
  }
  const layers = await Promise.all(tasks);

  let candidates = layers.flatMap((l) => l.candidates);
  let usedWeb = false;
  if (!candidates.length && deps.webSearch) {
    const search = deps.webSearch;
    const web = await runLayer("L4", deps, () => retrieveWeb(query, search, deps.rerank));
    layers.push(web);
    candidates = web.candidates;
    usedWeb = web.candidates.length > 0;
  }

  // ordem para o verificador: indicador determinístico, checagens, documentos, web;
  // dentro da camada, melhor tier e maior relevância primeiro
  const order: Record<KbLayer, number> = { L2: 0, L1: 1, L3: 2, L4: 3 };
  candidates.sort((a, b) =>
    order[a.layer] - order[b.layer] || a.source_tier - b.source_tier || b.relevance - a.relevance);

  return { candidates, comparison, layers, used_web: usedWeb };
}
