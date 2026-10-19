// L2 — indicadores oficiais. A comparação numérica é DETERMINÍSTICA (código),
// não do modelo: resolve o período, agrega a série quando preciso e aplica a
// tolerância. A evidência é gerada aqui, com a URL da série (quote_verified=true).
import type { IndicatorMatch, IndicatorRef, IndicatorSeries, IndicatorValue, SourceTier, Verdict } from "@actually/db";
import { INDICATOR_MIN_SCORE } from "../config";
import { canonicalUnit, normalizeText } from "../normalize";
import type { PipelineStore } from "../store";
import type { ComparisonStatus, EvidenceCandidate, IndicatorComparison } from "../types";

// ---------------------------------------------------------------------------
// Períodos
// ---------------------------------------------------------------------------
export interface Period {
  kind: "year" | "quarter" | "month" | "range";
  /** YYYY-MM-DD inclusivo. */
  start: string;
  end: string;
  label: string;
  from?: Period;
  to?: Period;
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "2023" | "2023-T4" (ou Q4) | "2023-12" | "2019..2022" → Period. */
export function parsePeriod(raw: string | null | undefined): Period | null {
  if (!raw) return null;
  const p = raw.trim();
  const range = p.match(/^(.+?)\s*\.\.\s*(.+)$/);
  if (range) {
    const from = parsePeriod(range[1]);
    const to = parsePeriod(range[2]);
    if (!from || !to || from.kind === "range" || to.kind === "range" || from.start > to.start) return null;
    return { kind: "range", start: from.start, end: to.end, label: `${from.label} a ${to.label}`, from, to };
  }
  let m = p.match(/^(\d{4})$/);
  if (m) {
    const y = Number(m[1]);
    return { kind: "year", start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}` };
  }
  m = p.match(/^(\d{4})-?[TQ]([1-4])$/i);
  if (m) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const m0 = (q - 1) * 3 + 1;
    return {
      kind: "quarter", start: `${y}-${pad(m0)}-01`, end: `${y}-${pad(m0 + 2)}-${lastDay(y, m0 + 2)}`,
      label: `${q}º tri/${y}`,
    };
  }
  m = p.match(/^(\d{4})-(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return { kind: "month", start: `${y}-${pad(mo)}-01`, end: `${y}-${pad(mo)}-${lastDay(y, mo)}`, label: `${MONTHS[mo - 1]}/${y}` };
  }
  return null;
}

function valueLabel(v: IndicatorValue): string {
  const [ys, ms] = v.period_start.split("-");
  const [ye, me] = v.period_end.split("-");
  if (ys === ye && ms === me) return `${MONTHS[Number(ms) - 1]}/${ys}`;
  if (ys === ye && ms === "01" && me === "12") return `${ys}`;
  return `${MONTHS[Number(ms) - 1]}/${ys} a ${MONTHS[Number(me) - 1]}/${ye}`;
}

/** Valor candidato para um período, com rótulo legível. */
export interface PeriodValue {
  label: string;
  value: number;
}

/**
 * Valores que representam o período pedido:
 * - período exato na série → ele;
 * - trimestre móvel + mês → trimestre que termina no mês;
 * - série mais fina que o período (mensal/trimestral em ano, mensal em trimestre) →
 *   média (só com o período completo) e último valor;
 * - sem período → último dado disponível.
 */
export function valuesForPeriod(
  period: Period | null,
  values: IndicatorValue[],
  periodicity: IndicatorSeries["periodicity"],
): PeriodValue[] {
  const sorted = [...values].sort((a, b) => a.period_start.localeCompare(b.period_start));
  if (!period) {
    const last = sorted[sorted.length - 1];
    return last ? [{ label: `${valueLabel(last)} (último dado disponível)`, value: last.value }] : [];
  }
  if (period.kind === "range") return [];

  const exact = sorted.find((v) => v.period_start === period.start && v.period_end === period.end);
  if (exact) return [{ label: period.kind === "year" && periodicity !== "annual" ? `${period.label}` : valueLabel(exact), value: exact.value }];

  if (periodicity === "moving_quarter" && period.kind === "month") {
    const v = sorted.find((x) => x.period_end >= period.start && x.period_end <= period.end);
    return v ? [{ label: `trimestre móvel ${valueLabel(v)}`, value: v.value }] : [];
  }
  if (periodicity === "annual") return [];

  let inside = sorted.filter((v) => v.period_start >= period.start && v.period_end <= period.end);
  let expected: number;
  if (periodicity === "monthly") {
    expected = period.kind === "year" ? 12 : period.kind === "quarter" ? 3 : 1;
  } else {
    // quarterly e moving_quarter: usa os trimestres civis (jan–mar, abr–jun, ...)
    if (period.kind === "month") return [];
    inside = inside.filter((v) => ["01", "04", "07", "10"].includes(v.period_start.slice(5, 7)));
    expected = period.kind === "year" ? 4 : 1;
  }
  if (!inside.length) return [];
  const last = inside[inside.length - 1]!;
  const out: PeriodValue[] = [];
  if (inside.length === expected) {
    const avg = inside.reduce((s, v) => s + v.value, 0) / inside.length;
    out.push({ label: `${period.label} (média ${period.kind === "year" ? "anual" : "do período"})`, value: avg });
    out.push({ label: `${valueLabel(last)} (último de ${period.label})`, value: last.value });
  } else {
    // período incompleto: média parcial enganaria — só o último dado
    out.push({ label: `${valueLabel(last)} (último dado disponível de ${period.label})`, value: last.value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unidades e tolerância
// ---------------------------------------------------------------------------

/** Escala embutida na unidade da série: "mil pessoas" → 1e3 × "pessoas". */
export function unitScale(unit: string): { base: string | null; factor: number } {
  const u = normalizeText(unit);
  const m = u.match(/^(mil|milhoes|milhao|bilhoes|bilhao)(?: de)? (.+)$/);
  if (m) {
    const factor = m[1] === "mil" ? 1e3 : m[1]!.startsWith("milh") ? 1e6 : 1e9;
    return { base: canonicalUnit(m[2]!), factor };
  }
  return { base: canonicalUnit(unit), factor: 1 };
}

/** "%" ou "p.p." ⇒ max(0,3 p.p.; 5% relativo); demais ⇒ 10% relativo. */
export function toleranceFor(isPercent: boolean, actual: number): number {
  return isPercent ? Math.max(0.3, 0.05 * Math.abs(actual)) : 0.1 * Math.abs(actual);
}

export function classify(claimed: number, actual: number, tolerance: number): Exclude<ComparisonStatus, "no_data"> {
  const diff = Math.abs(claimed - actual);
  // epsilon: 7,8 − 7,5 não pode virar 0,30000000000000027 > 0,3
  const eps = 1e-9 * Math.max(1, Math.abs(actual), Math.abs(claimed));
  if (diff <= tolerance + eps) return "match";
  if (diff <= 2 * tolerance + eps) return "minor_mismatch";
  return "mismatch";
}

const STATUS_RANK: Record<Exclude<ComparisonStatus, "no_data">, number> = { match: 0, minor_mismatch: 1, mismatch: 2 };

export function verdictForStatus(s: ComparisonStatus): Verdict | null {
  return s === "match" ? "confirmado" : s === "minor_mismatch" ? "impreciso" : s === "mismatch" ? "contradito" : null;
}

const fmt = (v: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(v);

// ---------------------------------------------------------------------------
// Comparador
// ---------------------------------------------------------------------------
interface Candidate {
  actual: number;
  isPercent: boolean;
  /** Linhas da evidência (período = valor unidade). */
  lines: string[];
}

function noData(series: IndicatorSeries | null, reason: string, claimed: number | null = null): IndicatorComparison {
  return {
    status: "no_data", expected_verdict: null, series_code: series?.code ?? null, claimed,
    actual: null, tolerance: null, evidence_text: null, reason,
  };
}

/**
 * Compara o valor afirmado com a série oficial. Escolhe a leitura mais
 * favorável ao falante entre as plausíveis (média x último; p.p. x %) —
 * o sistema só acusa quando nenhuma leitura razoável sustenta a fala.
 */
export function compareIndicator(
  ref: IndicatorRef,
  series: IndicatorSeries,
  values: IndicatorValue[],
): IndicatorComparison {
  if (ref.claimed_value == null || !Number.isFinite(ref.claimed_value)) return noData(series, "sem_valor_afirmado");
  if (!values.length) return noData(series, "serie_vazia", ref.claimed_value);

  const { base, factor } = unitScale(series.unit);
  const seriesIsPercent = base === "%";
  const claimUnit = canonicalUnit(ref.unit);
  const currencies = ["R$", "US$"];
  // unidade incompatível (ex.: afirmou R$ sobre série em %): não compara
  if (claimUnit) {
    if (seriesIsPercent && ref.kind !== "change_pct" && !["%", "p.p."].includes(claimUnit)) return noData(series, "unidade_incompativel", ref.claimed_value);
    if (!seriesIsPercent && ref.kind !== "change_pct" && (claimUnit === "%" || claimUnit === "p.p.")) return noData(series, "unidade_incompativel", ref.claimed_value);
    if (currencies.includes(claimUnit) && base !== claimUnit) return noData(series, "unidade_incompativel", ref.claimed_value);
    if (base && currencies.includes(base) && !currencies.includes(claimUnit) && claimUnit !== "%") {
      return noData(series, "unidade_incompativel", ref.claimed_value);
    }
  }

  const period = parsePeriod(ref.period);
  if (ref.period && !period) return noData(series, "periodo_invalido", ref.claimed_value);
  const scaled = (v: number) => v * factor;
  const line = (label: string, v: number) => `${label} = ${fmt(v)} ${series.unit}`;
  const candidates: Candidate[] = [];

  if (ref.kind === "level") {
    if (period?.kind === "range") return noData(series, "nivel_com_intervalo", ref.claimed_value);
    for (const pv of valuesForPeriod(period, values, series.periodicity)) {
      candidates.push({ actual: scaled(pv.value), isPercent: seriesIsPercent, lines: [line(pv.label, pv.value)] });
    }
  } else if (ref.kind === "change_abs" || ref.kind === "change_pct") {
    if (period?.kind !== "range" || !period.from || !period.to) return noData(series, "variacao_sem_intervalo", ref.claimed_value);
    const a = valuesForPeriod(period.from, values, series.periodicity);
    const b = valuesForPeriod(period.to, values, series.periodicity);
    for (const va of a) {
      for (const vb of b) {
        const lines = [line(va.label, va.value), line(vb.label, vb.value)];
        // %-série com "caiu X%": pode ser p.p. ou relativo — considera as duas leituras
        const wantAbs = ref.kind === "change_abs";
        const wantPct = ref.kind === "change_pct" || (seriesIsPercent && claimUnit === "%");
        if (wantAbs) {
          const d = scaled(vb.value) - scaled(va.value);
          candidates.push({
            actual: d, isPercent: seriesIsPercent,
            lines: [...lines, `variação = ${fmt(vb.value - va.value)} ${seriesIsPercent ? "p.p." : series.unit}`],
          });
        }
        if (wantPct && va.value !== 0) {
          const pct = (vb.value / va.value - 1) * 100;
          candidates.push({ actual: pct, isPercent: true, lines: [...lines, `variação = ${fmt(pct)}%`] });
        }
      }
    }
  } else {
    // max / min no período (ou na série inteira)
    const inside = period
      ? values.filter((v) => v.period_start >= period.start && v.period_end <= period.end)
      : values;
    if (!inside.length) return noData(series, "sem_dados_no_periodo", ref.claimed_value);
    const pick = inside.reduce((best, v) => ((ref.kind === "max" ? v.value > best.value : v.value < best.value) ? v : best));
    candidates.push({
      actual: scaled(pick.value), isPercent: seriesIsPercent,
      lines: [`${ref.kind === "max" ? "máximo" : "mínimo"} ${period ? `em ${period.label}` : "da série"}: ${line(valueLabel(pick), pick.value)}`],
    });
  }

  if (!candidates.length) return noData(series, "sem_dados_no_periodo", ref.claimed_value);

  // magnitude: a extração pode perder o sinal ("caiu 3 p.p." → 3); sinal explícito oposto é divergência
  const claimed = ref.claimed_value;
  let best: { status: Exclude<ComparisonStatus, "no_data">; c: Candidate; tol: number; diff: number } | null = null;
  for (const c of candidates) {
    const isChange = ref.kind === "change_abs" || ref.kind === "change_pct";
    const signFlip = isChange && claimed < 0 && c.actual > 0;
    // variação afirmada sem sinal: compara magnitudes (a direção fica com o verificador)
    const effActual = isChange && claimed >= 0 ? Math.abs(c.actual) : c.actual;
    const tol = toleranceFor(c.isPercent, effActual);
    const status = signFlip ? "mismatch" : classify(claimed, effActual, tol);
    const diff = Math.abs(claimed - effActual) / (tol || 1);
    if (!best || STATUS_RANK[status] < STATUS_RANK[best.status] || (status === best.status && diff < best.diff)) {
      best = { status, c, tol, diff };
    }
  }
  const b = best!;
  return {
    status: b.status,
    expected_verdict: verdictForStatus(b.status),
    series_code: series.code,
    claimed,
    actual: b.c.actual,
    tolerance: b.tol,
    evidence_text: `Série ${series.name} (${series.source_name}): ${b.c.lines.join("; ")}`,
    reason: b.status,
  };
}

/** Busca a série pelo nome dito, carrega os valores e compara. */
export async function retrieveIndicator(
  ref: IndicatorRef,
  store: PipelineStore,
): Promise<{ comparison: IndicatorComparison; candidate: EvidenceCandidate | null }> {
  const matches = await store.findIndicator(ref.query, 3);
  const top: IndicatorMatch | undefined = matches.sort((a, b) => b.score - a.score)[0];
  if (!top || top.score < INDICATOR_MIN_SCORE) return { comparison: noData(null, "serie_nao_encontrada", ref.claimed_value), candidate: null };
  const series: IndicatorSeries = {
    code: top.code, name: top.name, aliases: [], unit: top.unit, periodicity: top.periodicity,
    source_name: top.source_name, source_url: top.source_url, tier: top.tier as SourceTier, notes: null,
  };
  const values = await store.indicatorValues(series.code);
  const comparison = compareIndicator(ref, series, values);
  if (comparison.status === "no_data" || !comparison.evidence_text) return { comparison, candidate: null };
  return {
    comparison,
    candidate: {
      layer: "L2",
      evidence_type: "indicator",
      url: series.source_url,
      source_name: series.source_name,
      source_tier: series.tier,
      published_at: null,
      title: series.name,
      text: comparison.evidence_text,
      relevance: 1,
      comparison,
    },
  };
}
