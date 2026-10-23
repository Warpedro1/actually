// Re-decisão offline de alertas a partir de decisões já salvas (sem chamar modelos).
// Espelha as regras de packages/pipeline/score.ts — inclusive as regras por tipo
// de fala (KIND_RULES), que vêm do próprio pipeline para não divergirem quando
// mudarem lá. Se o pipeline passar a exportar sua função de decisão, troque
// `decideAlert` por ela.
import { isAgencyCheck } from "@actually/db";
import { KIND_RULES, RED_REVIEW_BAND, RED_REVIEW_MIN_CONFIDENCE, type ClaimDecision } from "@actually/pipeline";
import type { DecisionRecord } from "./dataset";
import { maxAlert, precisionRecall, ratio, type Predicted } from "./metrics";

export interface Thresholds {
  t_red: number;
  t_yellow: number;
  web_penalty: number;
}

type DecisionCore = Pick<
  ClaimDecision,
  "verdict" | "kind" | "model_confidence" | "final_score" | "layer" | "evidence" | "alert" | "silence_reason"
>;

const isHttp = (url: string) => /^https?:\/\//i.test(url);
const usable = (e: DecisionCore["evidence"][number]) => e.quote_verified && isHttp(e.url) && e.quote.trim().length > 0;

/** Regra dura de qualquer alerta: ≥1 evidência com URL e trecho verificado (trigger do banco). */
export function hasVerifiedEvidence(d: Pick<ClaimDecision, "evidence">): boolean {
  return d.evidence.some(usable);
}

/** Melhor nível de fonte entre as evidências aproveitáveis (score.ts: `bestEvidence`). */
export function bestTier(d: Pick<ClaimDecision, "evidence">): number | null {
  const tiers = d.evidence.filter(usable).map((e) => e.source_tier);
  return tiers.length ? Math.min(...tiers) : null;
}

/**
 * Regra dura do vermelho: evidência verificada de nível aceitável para o tipo
 * da fala (`KIND_RULES[kind].red_max_tier` — hoje 3 em fato, estatística e
 * acusação; 2 em opinião mensurável). Ler do pipeline é o que evita a
 * divergência que existia aqui: o limite estava fixo em 2.
 */
export function hasRedGradeEvidence(d: Pick<ClaimDecision, "evidence" | "kind">): boolean {
  const tier = bestTier(d);
  return tier !== null && tier <= KIND_RULES[d.kind ?? "fato"].red_max_tier;
}

/**
 * Motivos de silêncio que não dependem de t_red/t_yellow: se o pipeline calou por
 * um deles, nenhum limiar faz o alerta sair, e a re-decisão tem de calar também
 * (há regras aqui que este módulo não tem como recalcular — conflito entre
 * camadas, correção sem número com fonte, divergência do indicador).
 */
const thresholdSilence = new Set(["abaixo_do_threshold"]);

/**
 * Decide o alerta de uma afirmação com outros thresholds. As regras duras
 * (citação verificada, nível da fonte, nível máximo do tipo) NÃO dependem do
 * threshold: nenhum valor de t_red/t_yellow faz passar uma afirmação que as
 * viola. Vermelho que falha só na regra de nível não é rebaixado a amarelo.
 */
export function decideAlert(d: DecisionCore, t: Thresholds): Predicted {
  if (d.verdict !== "contradito" && d.verdict !== "impreciso") return null;
  if (d.alert === null && d.silence_reason && !thresholdSilence.has(d.silence_reason)) return null;
  if (!hasVerifiedEvidence(d)) return null;
  const tier = bestTier(d);
  if (tier === null || tier >= 4) return null;
  const rules = KIND_RULES[d.kind ?? "fato"];
  if (tier > rules.max_tier) return null;
  // checagem de agência (nível 1) com citação verificada não paga o acréscimo da web (score.ts)
  const agency = d.evidence.some((e) => e.quote_verified && e.source_tier === 1 && isAgencyCheck(e.url));
  const penalty = d.layer === "L4" && !agency ? t.web_penalty : 0;
  // opinião mensurável nunca vira vermelho: no máximo "impreciso"
  const level: Exclude<Predicted, null> =
    d.verdict === "contradito" && rules.max_level !== "yellow" ? "red" : "yellow";
  if (level === "red" && !hasRedGradeEvidence(d)) return null;
  const threshold = (level === "red" ? t.t_red : t.t_yellow) + penalty + rules.extra_threshold;
  if (d.final_score >= threshold) return level;
  // faixa de revisão: vermelho de fato/estatística logo abaixo do limiar vai ao
  // editor em vez de ser descartado, então para o eval ele foi emitido.
  const inBand =
    level === "red" &&
    (d.kind === "fato" || d.kind === "estatistica") &&
    (d.model_confidence ?? 0) >= RED_REVIEW_MIN_CONFIDENCE &&
    d.final_score >= threshold - RED_REVIEW_BAND - 1e-9;
  return inBand ? "red" : null;
}

/** Aplica novos thresholds a todas as decisões, devolvendo registros re-decididos. */
export function rethreshold(recs: DecisionRecord[], t: Thresholds): DecisionRecord[] {
  return recs.map((r) => ({
    ...r,
    decisions: r.decisions.map((d) => ({ ...d, alert: decideAlert(d, t) })),
  }));
}

/**
 * Quantas decisões salvas a regra local reproduz com os thresholds usados no run.
 * Abaixo de 100% indica que score.ts tem regras que este módulo não conhece.
 */
export function agreement(recs: DecisionRecord[], t: Thresholds): { n: number; agree: number; rate: number | null } {
  let n = 0, agree = 0;
  for (const r of recs) {
    for (const d of r.decisions) {
      n++;
      if (decideAlert(d, t) === d.alert) agree++;
    }
  }
  return { n, agree, rate: ratio(agree, n) };
}

export interface SweepPoint extends Thresholds {
  /** Itens com o nível emitido. */
  emitted: number;
  precision: number | null;
  /** Cobertura = recall (fração dos itens rotulados com o nível que foram pegos). */
  recall: number | null;
  /** Só para amarelo: precisão contando amarelo sobre um vermelho esperado como acerto. */
  lenient_precision?: number | null;
}

export function grid(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i++) out.push(Math.round((from + i * step) * 1000) / 1000);
  return out;
}

export function sweepRed(recs: DecisionRecord[], base: Thresholds, tReds: number[]): SweepPoint[] {
  return tReds.map((t_red) => {
    const th = { ...base, t_red };
    const pr = precisionRecall(rethreshold(recs, th), "red");
    return { ...th, emitted: pr.predicted, precision: pr.precision, recall: pr.recall };
  });
}

export function sweepYellow(recs: DecisionRecord[], base: Thresholds, tYellows: number[]): SweepPoint[] {
  return tYellows.map((t_yellow) => {
    const th = { ...base, t_yellow };
    const re = rethreshold(recs, th);
    const pr = precisionRecall(re, "yellow");
    const yellows = re.filter((r) => !r.error && maxAlert(r.decisions.map((d) => d.alert)) === "yellow");
    const lenient = ratio(yellows.filter((r) => r.expected.alert !== null).length, yellows.length);
    return { ...th, emitted: pr.predicted, precision: pr.precision, recall: pr.recall, lenient_precision: lenient };
  });
}

/**
 * Menor threshold com precisão ≥ alvo que se mantém para todos os thresholds
 * maiores (com pelo menos `minEmitted` emissões). Evita escolher um "vale de sorte"
 * em que a precisão volta a cair logo acima. Pontos sem emissão não contam
 * nem a favor nem contra. null = nenhum threshold atinge o alvo.
 */
export function recommend(
  points: SweepPoint[],
  key: "t_red" | "t_yellow",
  target: number,
  metric: (p: SweepPoint) => number | null = (p) => p.precision,
  minEmitted = 1,
): SweepPoint | null {
  const sorted = [...points].sort((a, b) => a[key] - b[key]);
  let best: SweepPoint | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    if (p.emitted < minEmitted) continue;
    const m = metric(p);
    if (m === null || m < target) break;
    best = p;
  }
  return best;
}
