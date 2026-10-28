// Orquestra a recuperação: L1–L3 em paralelo (cada uma com seu timeout). A L4
// (web) começa junto e só é aguardada quando a base vem fraca (sem evidência,
// ou só com evidência de relevância baixa): aí entra como complemento. Camada da
// base que estoura o prazo enquanto a L4 ainda roda pode chegar até a L4 terminar.
// Com a busca desligada no debate (settings.web_search), a L4 nem começa.
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

interface LayerDone<X> {
  outcome: LayerOutcome;
  extra: X | null;
  /** Erro da própria camada (o aviso "layer_failed" sai uma vez, de quem usa o resultado). */
  failure?: Record<string, unknown>;
}

interface LayerRun<X> extends LayerDone<X> {
  /**
   * Só com `keepLate`: a camada estourou o prazo e este é o resultado que ainda pode chegar
   * (nunca rejeita). retrieveAll decide se espera por ele — base fraca com a L4 ainda
   * rodando — ou o descarta inteiro; o aviso do prazo estourado fica com quem decide.
   */
  late: Promise<LayerDone<X>> | null;
}

/**
 * Roda a camada com timeout. O que ela produz (candidatos e, na L2, a comparação) só
 * vale se chegou dentro do prazo: viaja no valor resolvido, nunca por variável externa
 * — um resultado que chega depois do timeout é descartado inteiro (ou, com `keepLate`,
 * devolvido em `late` para quem pode esperar mais).
 */
async function runLayerWith<X>(
  layer: KbLayer,
  deps: PipelineDeps,
  fn: () => Promise<{ candidates: EvidenceCandidate[]; extra: X | null }>,
  keepLate = false,
): Promise<LayerRun<X>> {
  const t0 = deps.now();
  const settled: Promise<LayerDone<X>> = Promise.resolve()
    .then(fn)
    .then(
      (r) => ({ outcome: { layer, candidates: r.candidates, latency_ms: deps.now() - t0 }, extra: r.extra }),
      (err: unknown) => {
        const failure = errorFields(err);
        return { outcome: { layer, candidates: [], latency_ms: deps.now() - t0, error: failure.error as string }, extra: null, failure };
      },
    );
  try {
    const r = await withTimeout(settled, TIMEOUTS_MS[layer], `retrieve_${layer}`);
    if (r.failure) deps.logger("warn", "layer_failed", { layer, ...r.failure });
    return { ...r, late: null };
  } catch (err) {
    const failure = errorFields(err);
    const outcome = { layer, candidates: [], latency_ms: deps.now() - t0, error: failure.error as string };
    if (keepLate) return { outcome, extra: null, failure, late: settled };
    deps.logger("warn", "layer_failed", { layer, ...failure });
    return { outcome, extra: null, failure, late: null };
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
 * Base fraca com camada que estourou o prazo e a L4 ainda rodando: sem a camada, a
 * recuperação esperaria a L4 de qualquer jeito, então a camada pode chegar até a L4
 * terminar (no máximo TIMEOUTS_MS.L4, o prazo da própria L4) sem aumentar a latência.
 * O que chega depois disso é descartado inteiro.
 */
async function awaitLate<X>(runs: LayerRun<X>[], web: Promise<LayerOutcome>, deps: PipelineDeps): Promise<LayerRun<X>[]> {
  const webDone = web.then(() => null);
  return Promise.all(runs.map(async (r) => {
    if (!r.late) return r;
    const got = await Promise.race([r.late, webDone]);
    const used = got ?? r;
    if (used.failure) deps.logger("warn", "layer_failed", { layer: used.outcome.layer, ...used.failure });
    else deps.logger("info", "layer_late", { layer: used.outcome.layer, latency_ms: used.outcome.latency_ms });
    return { ...used, late: null };
  }));
}

/** Base forte ou L4 já encerrada: o que estourou o prazo é descartado, como sempre. */
function dropLate<X>(runs: LayerRun<X>[], deps: PipelineDeps): LayerRun<X>[] {
  return runs.map((r) => {
    if (!r.late) return r;
    deps.logger("warn", "layer_failed", { layer: r.outcome.layer, ...r.failure });
    return { ...r, late: null };
  });
}

/**
 * A base resolve sozinha? Indicador com dado, ou checagem/documento com
 * relevância alta. Se não, a web complementa (o verificador recebe as duas).
 */
export function baseIsStrong(candidates: EvidenceCandidate[], comparison: IndicatorComparison | null): boolean {
  if (comparison && comparison.status !== "no_data") return true;
  return candidates.some(
    (c) => (c.layer === "L1" || c.layer === "L3") && !c.weak && c.relevance >= WEB_SKIP_MIN_RELEVANCE[c.layer],
  );
}

/** Opinião/previsão: documentos e web procuram o dado que mede a fala; checagens, a própria fala. */
export function measureQueryOf(claim: Pick<ExtractedClaim, "measurable" | "text_normalized">): string {
  return claim.measurable ?? claim.text_normalized;
}

export async function retrieveAll(
  deps: PipelineDeps,
  claim: ExtractedClaim,
  embedding: number[] | null,
  opts: { web?: boolean } = {},
): Promise<RetrievalResult> {
  const query = claim.text_normalized;
  const measureQuery = measureQueryOf(claim);

  // a web começa já (latência); o resultado só é usado se a base vier fraca.
  // runLayer nunca rejeita e tem timeout: se não for aguardada, termina sozinha.
  // Desligada no debate: a Tavily não é chamada e tudo segue o caminho de "sem chave"
  const search = opts.web === false ? null : deps.webSearch;
  const web_off = opts.web === false ? "debate" : search ? null : "sem_chave";
  const web = search ? runLayer("L4", deps, () => retrieveWeb(measureQuery, search, deps.rerank)) : null;
  // com a L4 rodando, a camada da base que estoura o prazo ainda pode chegar (awaitLate)
  const keepLate = web !== null;

  const tasks: Promise<LayerRun<IndicatorComparison>>[] = [];
  if (embedding) {
    tasks.push(runLayerWith<IndicatorComparison>("L1", deps, async () => ({
      candidates: await retrieveFactchecks(query, embedding, deps.store, deps.rerank, deps.logger), extra: null,
    }), keepLate));
  }
  // a comparação L2 só existe junto com a camada L2 concluída no prazo. Fato de
  // referência (mandatos, eleições) e indicador são comparados em código; a
  // referência tem prioridade (a fala sobre "anos no poder" não é série econômica)
  const reference = claim.reference;
  const indicator = claim.indicator;
  if (reference) {
    const asOf = new Date(deps.now()).toISOString().slice(0, 10);
    tasks.push(runLayerWith("L2", deps, async () => {
      const r = await retrieveReference(reference, deps.store, asOf);
      return { candidates: r.candidate ? [r.candidate] : [], extra: r.comparison };
    }, keepLate));
  } else if (indicator) {
    tasks.push(runLayerWith("L2", deps, async () => {
      const r = await retrieveIndicator(indicator, deps.store);
      return { candidates: r.candidate ? [r.candidate] : [], extra: r.comparison };
    }, keepLate));
  }
  if (embedding) {
    tasks.push(runLayerWith<IndicatorComparison>("L3", deps, async () => ({
      candidates: await retrieveDocuments(measureQuery, embedding, deps.store, deps.rerank, deps.logger), extra: null,
    }), keepLate));
  }
  const onTime = await Promise.all(tasks);
  const comparisonOf = (rs: LayerRun<IndicatorComparison>[]) => rs.find((r) => r.outcome.layer === "L2")?.extra ?? null;
  // base fraca no prazo com a L4 rodando: o que estourou o prazo ainda pode chegar até o fim
  // da L4. Base forte no prazo: nada muda (não espera a camada lenta)
  const strongOnTime = baseIsStrong(onTime.flatMap((r) => r.outcome.candidates), comparisonOf(onTime));
  const runs = web && !strongOnTime ? await awaitLate(onTime, web, deps) : dropLate(onTime, deps);
  const layers = runs.map((r) => r.outcome);
  const comparison = comparisonOf(runs);

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

  // o que a web trouxe vale para a base mesmo quando não entrou aqui (index.ts grava
  // depois dos alertas); a camada não rejeita, então ninguém precisa esperar por isto
  const web_found = web ? web.then((w) => w.candidates) : null;
  return { candidates, comparison, layers, used_web: usedWeb, web_found, web_off };
}
