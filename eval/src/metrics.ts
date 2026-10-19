// Métricas do eval — funções puras sobre DecisionRecord[] (sem rede, sem IO).
import type { ClaimDecision } from "@actually/pipeline";
import type { AlertLevel, DecisionRecord } from "./dataset";

export type Predicted = AlertLevel | null;

const SEVERITY: Record<"red" | "yellow" | "none", number> = { red: 2, yellow: 1, none: 0 };

/** Nível mais severo entre alertas (red > yellow > null). */
export function maxAlert(alerts: Predicted[]): Predicted {
  let best: Predicted = null;
  for (const a of alerts) {
    if (SEVERITY[a ?? "none"] > SEVERITY[best ?? "none"]) best = a;
  }
  return best;
}

/**
 * O que o público veria para o item: o alerta mais severo entre as afirmações
 * extraídas da fala. Item com erro conta como silêncio (é o que aconteceria ao vivo).
 */
export function predictedAlert(rec: Pick<DecisionRecord, "error" | "decisions">): Predicted {
  if (rec.error) return null;
  return maxAlert(rec.decisions.map((d) => d.alert));
}

/** Percentil com interpolação linear (igual ao padrão do numpy). null se vazio. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (p <= 0) return xs[0]!;
  if (p >= 100) return xs[xs.length - 1]!;
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return xs[lo]! + (xs[hi]! - xs[lo]!) * frac;
}

export function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

export interface PrecisionRecall {
  /** Itens em que o sistema emitiu o nível. */
  predicted: number;
  /** Itens rotulados com o nível. */
  expected: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

/**
 * Precisão/recall por item para um nível de alerta.
 * `level = "any"` trata vermelho e amarelo como "houve alerta".
 */
export function precisionRecall(recs: DecisionRecord[], level: AlertLevel | "any"): PrecisionRecall {
  let tp = 0, fp = 0, fn = 0, predicted = 0, expected = 0;
  for (const r of recs) {
    const pred = predictedAlert(r);
    const exp = r.expected.alert;
    const p = level === "any" ? pred !== null : pred === level;
    const e = level === "any" ? exp !== null : exp === level;
    if (p) predicted++;
    if (e) expected++;
    if (p && e) tp++;
    else if (p) fp++;
    else if (e) fn++;
  }
  return { predicted, expected, tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
}

/** Entre os amarelos emitidos, quantos tinham algum alerta esperado (vermelho ou amarelo). */
export function yellowLenientPrecision(recs: DecisionRecord[]): number | null {
  const yellows = recs.filter((r) => predictedAlert(r) === "yellow");
  return ratio(yellows.filter((r) => r.expected.alert !== null).length, yellows.length);
}

export interface RateStat {
  n: number;
  hits: number;
  rate: number | null;
}

function rate(recs: DecisionRecord[], pred: (r: DecisionRecord) => boolean): RateStat {
  const hits = recs.filter(pred).length;
  return { n: recs.length, hits, rate: ratio(hits, recs.length) };
}

export interface FalseAlarm {
  /** Afirmações rotuladas como verdadeiras (verdict = confirmado). */
  on_true: RateStat;
  /** Falas sem afirmação checável. */
  on_uncheckable: RateStat;
  /** União dos dois acima — a métrica principal de falso alarme. */
  on_true_or_uncheckable: RateStat;
  /** Qualquer item sem alerta esperado (inclui inconclusivos e contraditos sem alerta). */
  on_no_alert_expected: RateStat;
  /** Vermelhos emitidos onde nenhum alerta era esperado — o pior erro possível. */
  red_on_no_alert_expected: RateStat;
}

export function falseAlarm(recs: DecisionRecord[]): FalseAlarm {
  const alerted = (r: DecisionRecord) => predictedAlert(r) !== null;
  const isTrue = (r: DecisionRecord) => r.expected.verdict === "confirmado";
  const isUncheckable = (r: DecisionRecord) => !r.expected.checkable;
  const noAlert = recs.filter((r) => r.expected.alert === null);
  return {
    on_true: rate(recs.filter(isTrue), alerted),
    on_uncheckable: rate(recs.filter(isUncheckable), alerted),
    on_true_or_uncheckable: rate(recs.filter((r) => isTrue(r) || isUncheckable(r)), alerted),
    on_no_alert_expected: rate(noAlert, alerted),
    red_on_no_alert_expected: rate(noAlert, (r) => predictedAlert(r) === "red"),
  };
}

export interface Silence {
  /** Itens sem nenhum alerta emitido / total. */
  overall: RateStat;
  /** Itens que deveriam alertar e ficaram em silêncio (= 1 − recall de alertas). */
  on_expected_alert: RateStat;
  /** Itens em que evaluateText lançou. */
  errors: RateStat;
}

export function silence(recs: DecisionRecord[]): Silence {
  const silent = (r: DecisionRecord) => predictedAlert(r) === null;
  return {
    overall: rate(recs, silent),
    on_expected_alert: rate(recs.filter((r) => r.expected.alert !== null), silent),
    errors: rate(recs, (r) => r.error !== null),
  };
}

export const NO_CLAIM_REASON = "(nenhuma afirmação extraída)";
export const ERROR_REASON = "(erro no pipeline)";
export const MISSING_REASON = "(sem silence_reason)";

/**
 * Distribuição de silence_reason. Conta por afirmação silenciada; itens sem
 * afirmação extraída e itens com erro entram com rótulos próprios.
 */
export function silenceReasons(recs: DecisionRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (k: string) => (out[k] = (out[k] ?? 0) + 1);
  for (const r of recs) {
    if (r.error) {
      add(ERROR_REASON);
      continue;
    }
    if (r.decisions.length === 0) {
      add(NO_CLAIM_REASON);
      continue;
    }
    for (const d of r.decisions) if (d.alert === null) add(d.silence_reason ?? MISSING_REASON);
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

export interface LatencyStat {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function latencyStat(values: number[]): LatencyStat {
  const xs = values.filter((v) => Number.isFinite(v));
  return {
    n: xs.length,
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    max: xs.length ? Math.max(...xs) : null,
  };
}

export const TOTAL_KEY = "total (item, parede)";

/**
 * Latência por etapa. Para cada item, o valor de uma etapa é o máximo entre
 * suas afirmações (etapas comuns, como filtro/extração, se repetem; etapas por
 * afirmação rodam em paralelo, então o máximo é o caminho crítico).
 * O total é o tempo de parede de evaluateText. Itens com erro ficam de fora.
 */
export function latencyByStage(recs: DecisionRecord[]): Record<string, LatencyStat> {
  const perStage = new Map<string, number[]>();
  const ok = recs.filter((r) => !r.error);
  for (const r of ok) {
    const itemMax = new Map<string, number>();
    for (const d of r.decisions) {
      for (const [k, v] of Object.entries(d.latency_ms ?? {})) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        itemMax.set(k, Math.max(itemMax.get(k) ?? 0, v));
      }
    }
    for (const [k, v] of itemMax) {
      if (!perStage.has(k)) perStage.set(k, []);
      perStage.get(k)!.push(v);
    }
  }
  const out: Record<string, LatencyStat> = {};
  for (const k of [...perStage.keys()].sort()) out[k] = latencyStat(perStage.get(k)!);
  out[TOTAL_KEY] = latencyStat(ok.map((r) => r.wall_ms));
  return out;
}

export type ConfusionKey = "red" | "yellow" | "none";
/** Matriz esperado (linhas) × emitido (colunas). */
export type Confusion = Record<ConfusionKey, Record<ConfusionKey, number>>;

export function confusion(recs: DecisionRecord[]): Confusion {
  const zero = (): Record<ConfusionKey, number> => ({ red: 0, yellow: 0, none: 0 });
  const m: Confusion = { red: zero(), yellow: zero(), none: zero() };
  for (const r of recs) m[r.expected.alert ?? "none"][predictedAlert(r) ?? "none"]++;
  return m;
}

export interface SliceSummary {
  n: number;
  expected_red: number;
  expected_yellow: number;
  predicted_red: number;
  predicted_yellow: number;
  red_precision: number | null;
  red_recall: number | null;
  alert_precision: number | null;
  alert_recall: number | null;
  /** Taxa de falso alarme sobre itens sem alerta esperado. */
  false_alarm_rate: number | null;
}

export function sliceSummary(recs: DecisionRecord[]): SliceSummary {
  const red = precisionRecall(recs, "red");
  const yellow = precisionRecall(recs, "yellow");
  const any = precisionRecall(recs, "any");
  return {
    n: recs.length,
    expected_red: red.expected,
    expected_yellow: yellow.expected,
    predicted_red: red.predicted,
    predicted_yellow: yellow.predicted,
    red_precision: red.precision,
    red_recall: red.recall,
    alert_precision: any.precision,
    alert_recall: any.recall,
    false_alarm_rate: falseAlarm(recs).on_no_alert_expected.rate,
  };
}

export function sliceBy(
  recs: DecisionRecord[],
  key: (r: DecisionRecord) => string,
): Record<string, SliceSummary> {
  const groups = new Map<string, DecisionRecord[]>();
  for (const r of recs) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const out: Record<string, SliceSummary> = {};
  for (const k of [...groups.keys()].sort()) out[k] = sliceSummary(groups.get(k)!);
  return out;
}

export type ErrorKind =
  | "vermelho indevido"
  | "amarelo indevido"
  | "vermelho perdido"
  | "amarelo perdido"
  | "vermelho emitido como amarelo"
  | "amarelo emitido como vermelho";

/** Ordem de gravidade para listar erros (falso alarme vermelho primeiro). */
const ERROR_ORDER: ErrorKind[] = [
  "vermelho indevido",
  "amarelo emitido como vermelho",
  "amarelo indevido",
  "vermelho perdido",
  "vermelho emitido como amarelo",
  "amarelo perdido",
];

export function classifyError(expected: Predicted, predicted: Predicted): ErrorKind | null {
  if (expected === predicted) return null;
  if (expected === null) return predicted === "red" ? "vermelho indevido" : "amarelo indevido";
  if (predicted === null) return expected === "red" ? "vermelho perdido" : "amarelo perdido";
  return expected === "red" ? "vermelho emitido como amarelo" : "amarelo emitido como vermelho";
}

export interface EvalError {
  kind: ErrorKind;
  item_id: string;
  speaker: string;
  topic: string | null;
  text: string;
  expected: DecisionRecord["expected"];
  predicted: Predicted;
  error: string | null;
  reference_urls: string[];
  decisions: Pick<
    ClaimDecision,
    "claim" | "verdict" | "final_score" | "alert" | "silence_reason" | "layer" | "correction" | "evidence"
  >[];
}

export function listErrors(recs: DecisionRecord[]): EvalError[] {
  const out: EvalError[] = [];
  for (const r of recs) {
    const predicted = predictedAlert(r);
    const kind = classifyError(r.expected.alert, predicted);
    if (!kind) continue;
    out.push({
      kind,
      item_id: r.item_id,
      speaker: r.speaker,
      topic: r.topic,
      text: r.text,
      expected: r.expected,
      predicted,
      error: r.error,
      reference_urls: r.reference_urls,
      decisions: r.decisions.map(({ claim, verdict, final_score, alert, silence_reason, layer, correction, evidence }) => ({
        claim, verdict, final_score, alert, silence_reason, layer, correction, evidence,
      })),
    });
  }
  return out.sort((a, b) => ERROR_ORDER.indexOf(a.kind) - ERROR_ORDER.indexOf(b.kind) || a.item_id.localeCompare(b.item_id));
}

export interface EvalMetrics {
  n_items: number;
  n_synthetic: number;
  n_decisions: number;
  red: PrecisionRecall;
  yellow: PrecisionRecall & { lenient_precision: number | null };
  any_alert: PrecisionRecall;
  false_alarm: FalseAlarm;
  silence: Silence;
  silence_reasons: Record<string, number>;
  latency_ms: Record<string, LatencyStat>;
  confusion: Confusion;
  by_speaker: Record<string, SliceSummary>;
  by_topic: Record<string, SliceSummary>;
  errors: EvalError[];
}

export function computeMetrics(recs: DecisionRecord[]): EvalMetrics {
  return {
    n_items: recs.length,
    n_synthetic: recs.filter((r) => r.synthetic).length,
    n_decisions: recs.reduce((s, r) => s + r.decisions.length, 0),
    red: precisionRecall(recs, "red"),
    yellow: { ...precisionRecall(recs, "yellow"), lenient_precision: yellowLenientPrecision(recs) },
    any_alert: precisionRecall(recs, "any"),
    false_alarm: falseAlarm(recs),
    silence: silence(recs),
    silence_reasons: silenceReasons(recs),
    latency_ms: latencyByStage(recs),
    confusion: confusion(recs),
    by_speaker: sliceBy(recs, (r) => r.speaker),
    by_topic: sliceBy(recs, (r) => r.topic ?? "(sem tópico)"),
    errors: listErrors(recs),
  };
}
