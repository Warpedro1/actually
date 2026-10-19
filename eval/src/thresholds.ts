// Re-decisão offline de alertas a partir de decisões já salvas (sem chamar modelos).
// Espelha as regras de packages/pipeline/score.ts. Se o pipeline passar a exportar
// sua própria função de decisão, troque `decideAlert` por ela.
import type { ClaimDecision } from "@actually/pipeline";
import type { DecisionRecord } from "./dataset";
import { maxAlert, precisionRecall, ratio, type Predicted } from "./metrics";

export interface Thresholds {
  t_red: number;
  t_yellow: number;
  web_penalty: number;
}

type DecisionCore = Pick<ClaimDecision, "verdict" | "final_score" | "layer" | "evidence" | "alert">;

/** Regra dura de qualquer alerta: ≥1 evidência com URL e trecho verificado (trigger do banco). */
export function hasVerifiedEvidence(d: Pick<ClaimDecision, "evidence">): boolean {
  return d.evidence.some((e) => e.quote_verified && /^https?:\/\//i.test(e.url) && e.quote.trim().length > 0);
}

/** Regra dura do vermelho: evidência verificada de fonte tier ≤ 2. */
export function hasRedGradeEvidence(d: Pick<ClaimDecision, "evidence">): boolean {
  return d.evidence.some(
    (e) => e.quote_verified && e.source_tier <= 2 && /^https?:\/\//i.test(e.url) && e.quote.trim().length > 0,
  );
}

/**
 * Decide o alerta de uma afirmação com outros thresholds. As regras duras
 * (citação verificada; tier ≤ 2 para vermelho) NÃO dependem do threshold:
 * nenhum valor de t_red/t_yellow faz passar uma afirmação que as viola.
 * Vermelho que falha só na regra de tier não é rebaixado a amarelo.
 */
export function decideAlert(d: DecisionCore, t: Thresholds): Predicted {
  if (d.verdict !== "contradito" && d.verdict !== "impreciso") return null;
  if (!hasVerifiedEvidence(d)) return null;
  const penalty = d.layer === "L4" ? t.web_penalty : 0;
  if (d.verdict === "contradito") {
    if (!hasRedGradeEvidence(d)) return null;
    return d.final_score >= t.t_red + penalty ? "red" : null;
  }
  return d.final_score >= t.t_yellow + penalty ? "yellow" : null;
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
