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

/**
 * Roda a camada com timeout. O que ela produz (candidatos e, na L2, a comparação) só
 * vale se chegou dentro do prazo: viaja no valor resolvido, nunca por variável externa
 * — um resultado que chega depois do timeout é descartado inteiro.
 */
async function runLayerWith<X>(
  layer: KbLayer,
  deps: PipelineDeps,
  fn: () => Promise<{ candidates: EvidenceCandidate[]; extra: X | null }>,
): Promise<{ outcome: LayerOutcome; extra: X | null }> {
  const t0 = deps.now();
  try {
    const r = await withTimeout(fn(), TIMEOUTS_MS[layer], `retrieve_${layer}`);
    return { outcome: { layer, candidates: r.candidates, latency_ms: deps.now() - t0 }, extra: r.extra };
  } catch (err) {
    deps.logger("warn", "layer_failed", { layer, ...errorFields(err) });
    return { outcome: { layer, candidates: [], latency_ms: deps.now() - t0, error: errorFields(err).error as string }, extra: null };
  }
}

async function runLayer(
  layer: KbLayer,
  deps: PipelineDeps,
  fn: () => Promise<EvidenceCandidate[]>,
): Promise<LayerOutcome> {
  const r = await runLayerWith<never>(layer, deps, async () => ({ candidates: await fn(), extra: null }));
  return r.outcome;
}

export async function retrieveAll(
  deps: PipelineDeps,
  claim: ExtractedClaim,
  embedding: number[] | null,
): Promise<RetrievalResult> {
  const query = claim.text_normalized;

  const tasks: Promise<LayerOutcome>[] = [];
  if (embedding) {
    tasks.push(runLayer("L1", deps, () => retrieveFactchecks(query, embedding, deps.store, deps.rerank, deps.logger)));
  }
  // a comparação L2 só existe junto com a camada L2 concluída no prazo
  let l2: Promise<{ outcome: LayerOutcome; extra: IndicatorComparison | null }> | null = null;
  if (claim.indicator) {
    const ref = claim.indicator;
    l2 = runLayerWith("L2", deps, async () => {
      const r = await retrieveIndicator(ref, deps.store);
      return { candidates: r.candidate ? [r.candidate] : [], extra: r.comparison };
    });
    tasks.push(l2.then((r) => r.outcome));
  }
  if (embedding) {
    tasks.push(runLayer("L3", deps, () => retrieveDocuments(query, embedding, deps.store, deps.rerank, deps.logger)));
  }
  const layers = await Promise.all(tasks);
  const comparison = l2 ? (await l2).extra : null;

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
