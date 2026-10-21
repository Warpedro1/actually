// Orquestra a recuperação: L1–L3 em paralelo (cada uma com seu timeout). A L4
// (web) começa junto e só é aguardada quando a base vem fraca (sem evidência,
// ou só com evidência de relevância baixa): aí entra como complemento.
import type { KbLayer } from "@actually/db";
import { TIMEOUTS_MS, WEB_SKIP_MIN_RELEVANCE } from "../config";
import type { PipelineDeps } from "../deps";
import { errorFields, withTimeout } from "../log";
import type { EvidenceCandidate, ExtractedClaim, IndicatorComparison, LayerOutcome, RetrievalResult } from "../types";
import { retrieveDocuments } from "./documents";
import { retrieveFactchecks } from "./factchecks";
import { retrieveIndicator } from "./indicators";
import { retrieveReference } from "./reference";
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

/**
 * A base resolve sozinha? Indicador com dado, ou checagem/documento com
 * relevância alta. Se não, a web complementa (o verificador recebe as duas).
 */
export function baseIsStrong(candidates: EvidenceCandidate[], comparison: IndicatorComparison | null): boolean {
  if (comparison && comparison.status !== "no_data") return true;
  return candidates.some(
    (c) => (c.layer === "L1" || c.layer === "L3") && c.relevance >= WEB_SKIP_MIN_RELEVANCE[c.layer],
  );
}

export async function retrieveAll(
  deps: PipelineDeps,
  claim: ExtractedClaim,
  embedding: number[] | null,
): Promise<RetrievalResult> {
  const query = claim.text_normalized;
  // opinião/previsão: documentos e web procuram o dado que mede a fala; checagens, a própria fala
  const measureQuery = claim.measurable ?? query;

  // a web começa já (latência); o resultado só é usado se a base vier fraca.
  // runLayer nunca rejeita e tem timeout: se não for aguardada, termina sozinha.
  const search = deps.webSearch;
  const web = search ? runLayer("L4", deps, () => retrieveWeb(measureQuery, search, deps.rerank)) : null;

  const tasks: Promise<LayerOutcome>[] = [];
  if (embedding) {
    tasks.push(runLayer("L1", deps, () => retrieveFactchecks(query, embedding, deps.store, deps.rerank, deps.logger)));
  }
  // a comparação L2 só existe junto com a camada L2 concluída no prazo. Fato de
  // referência (mandatos, eleições) e indicador são comparados em código; a
  // referência tem prioridade (a fala sobre "anos no poder" não é série econômica)
  let l2: Promise<{ outcome: LayerOutcome; extra: IndicatorComparison | null }> | null = null;
  const reference = claim.reference;
  const indicator = claim.indicator;
  if (reference) {
    const asOf = new Date(deps.now()).toISOString().slice(0, 10);
    l2 = runLayerWith("L2", deps, async () => {
      const r = await retrieveReference(reference, deps.store, asOf);
      return { candidates: r.candidate ? [r.candidate] : [], extra: r.comparison };
    });
  } else if (indicator) {
    l2 = runLayerWith("L2", deps, async () => {
      const r = await retrieveIndicator(indicator, deps.store);
      return { candidates: r.candidate ? [r.candidate] : [], extra: r.comparison };
    });
  }
  if (l2) tasks.push(l2.then((r) => r.outcome));
  if (embedding) {
    tasks.push(runLayer("L3", deps, () => retrieveDocuments(measureQuery, embedding, deps.store, deps.rerank, deps.logger)));
  }
  const layers = await Promise.all(tasks);
  const comparison = l2 ? (await l2).extra : null;

  let candidates = layers.flatMap((l) => l.candidates);
  let usedWeb = false;
  if (web && !baseIsStrong(candidates, comparison)) {
    const w = await web;
    layers.push(w);
    usedWeb = w.candidates.length > 0;
    // a base veio fraca: o que ela trouxe pode ser citado, mas não soma como camada
    // independente nem tira o acréscimo da web (score.ts)
    candidates = [...(usedWeb ? candidates.map((c) => ({ ...c, weak: true })) : candidates), ...w.candidates];
  }

  // ordem para o verificador: indicador determinístico, checagens, documentos, web;
  // dentro da camada, melhor tier e maior relevância primeiro
  const order: Record<KbLayer, number> = { L2: 0, L1: 1, L3: 2, L4: 3 };
  candidates.sort((a, b) =>
    order[a.layer] - order[b.layer] || a.source_tier - b.source_tier || b.relevance - a.relevance);

  return { candidates, comparison, layers, used_web: usedWeb };
}
