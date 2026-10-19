// L2 — indicadores oficiais. A comparação numérica é DETERMINÍSTICA (código),
// não do modelo: resolve o período, agrega a série quando preciso e aplica a
// tolerância. A evidência é gerada aqui, com a URL da série (quote_verified=true).
// Na dúvida sobre QUAL série ou COMO ler o número, devolve no_data (silêncio da L2).
import type { IndicatorMatch, IndicatorRef, IndicatorSeries, IndicatorValue, SourceTier, Verdict } from "@actually/db";
import { INDICATOR_MIN_SCORE } from "../config";
import { canonicalUnit, normalizeText } from "../normalize";
import type { PipelineStore } from "../store";
import type { ComparisonStatus, EvidenceCandidate, IndicatorComparison } from "../types";

// ---------------------------------------------------------------------------
// Escolha da série (find_indicator devolve similaridade pg_trgm 0–1)
// ---------------------------------------------------------------------------
/** Quantas séries pedir ao find_indicator (para enxergar empates e a 2ª colocada). */
export const INDICATOR_MATCH_COUNT = 5;
/** Alias/nome igual ao dito, após minúsculas e sem acento (similaridade 1, com folga de float4). */
export const INDICATOR_EXACT_SCORE = 0.99;
/**
 * Casamento aproximado só vale acima disto E com margem clara sobre a 2ª série.
 * "dívida pública" × "dívida pública líquida" = 0,71 e "salário mínimo" × "salário médio"
 * = 0,47 ficam de fora: o qualificador que muda a medida é justamente o que o trigrama perdoa.
 */
export const INDICATOR_FUZZY_MIN_SCORE = 0.8;
/** Séries com score a menos disto da 1ª disputam a escolha (empate ⇒ precisa de desempate pela afirmação). */
export const INDICATOR_MIN_MARGIN = 0.25;

/**
 * Como a série se agrega num período mais longo que a sua periodicidade. Declarada no
 * catálogo do kb-ingest (campo `aggregation` de indicator_series):
 * - "sum": fluxo (saldo do Caged, PIB nominal trimestral) — ano/trimestre = soma, só com o período completo;
 * - "mean_or_last": taxa com média reconhecida (desocupação, Selic, câmbio) — média do período completo ou último ponto;
 * - "last": estoque (dívida % PIB) — ponto do fim do período;
 * - "accum_12m": acumulado em 12 meses (IPCA 12m, primário 12m) — ano civil = valor de dezembro; trimestre não;
 * - "none": não agrega (variação mensal do IPCA, variação trimestral do PIB) — só o período exato.
 * Ausente ou desconhecida ⇒ "none" (na dúvida, não agrega).
 */
export type IndicatorAggregation = "sum" | "mean_or_last" | "last" | "accum_12m" | "none";
export const INDICATOR_AGGREGATIONS: readonly IndicatorAggregation[] = ["sum", "mean_or_last", "last", "accum_12m", "none"];

export function toAggregation(v: unknown): IndicatorAggregation {
  return typeof v === "string" && (INDICATOR_AGGREGATIONS as readonly string[]).includes(v) ? (v as IndicatorAggregation) : "none";
}

/** Série como o comparador a usa (o banco devolve `aggregation` junto com a série). */
export type ComparableSeries = IndicatorSeries & { aggregation?: IndicatorAggregation | null };

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
 * A série consegue, em princípio, responder por esse período (independe de haver dados)?
 * Série mais fina que o período só responde se souber se agregar (`aggregation`).
 */
export function periodSupported(
  period: Period | null,
  periodicity: IndicatorSeries["periodicity"],
  aggregation: IndicatorAggregation,
): boolean {
  // fluxo sem período: o último mês não é leitura razoável de um total afirmado
  if (!period) return aggregation !== "sum";
  switch (period.kind) {
    case "range":
      return false;
    case "month":
      return periodicity === "monthly" || periodicity === "moving_quarter";
    case "quarter":
      if (periodicity === "quarterly" || periodicity === "moving_quarter") return true; // período exato
      if (periodicity === "annual") return false;
      return aggregation === "sum" || aggregation === "mean_or_last" || aggregation === "last";
    case "year":
      return periodicity === "annual" || aggregation !== "none";
  }
}

/**
 * Valores que representam o período pedido:
 * - período exato na série → ele;
 * - trimestre móvel + mês → trimestre que termina no mês;
 * - série mais fina que o período (mensal/trimestral em ano, mensal em trimestre) →
 *   conforme `aggregation`: soma (período completo), média (período completo) e último,
 *   ponto do fim, ou dezembro (acumulado 12m em ano civil);
 * - sem período → último dado disponível (exceto fluxo).
 */
export function valuesForPeriod(
  period: Period | null,
  values: IndicatorValue[],
  periodicity: IndicatorSeries["periodicity"],
  aggregation: IndicatorAggregation,
): PeriodValue[] {
  if (!periodSupported(period, periodicity, aggregation)) return [];
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

  if (aggregation === "accum_12m") {
    // ano civil = acumulado nos 12 meses terminados em dezembro (periodSupported já barrou trimestre)
    const dec = sorted.find((v) => v.period_end === period.end && v.period_start.slice(0, 7) === period.end.slice(0, 7));
    return dec ? [{ label: `${period.label} (12 meses até ${valueLabel(dec)})`, value: dec.value }] : [];
  }

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
  const complete = inside.length === expected;
  switch (aggregation) {
    case "sum": {
      // soma parcial enganaria (o total do período ainda não existe)
      if (!complete) return [];
      const total = inside.reduce((s, v) => s + v.value, 0);
      return [{ label: `${period.label} (soma de ${expected} ${periodicity === "monthly" ? "meses" : "trimestres"})`, value: total }];
    }
    case "last":
      return [{ label: `${valueLabel(last)} (${complete ? "fim" : "último dado disponível"} de ${period.label})`, value: last.value }];
    case "mean_or_last": {
      if (!complete) {
        // período incompleto: média parcial enganaria — só o último dado
        return [{ label: `${valueLabel(last)} (último dado disponível de ${period.label})`, value: last.value }];
      }
      const avg = inside.reduce((s, v) => s + v.value, 0) / inside.length;
      return [
        { label: `${period.label} (média ${period.kind === "year" ? "anual" : "do período"})`, value: avg },
        { label: `${valueLabel(last)} (último de ${period.label})`, value: last.value },
      ];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Unidades e tolerância
// ---------------------------------------------------------------------------

const SCALE_WORDS: Record<string, number> = {
  mil: 1e3, mi: 1e6, milhao: 1e6, milhoes: 1e6, bi: 1e9, bilhao: 1e9, bilhoes: 1e9, tri: 1e12, trilhao: 1e12, trilhoes: 1e12,
};

/**
 * Escala embutida numa unidade (da série ou da fala): "mil pessoas" → 1e3 × "pessoas";
 * "R$ milhões" → 1e6 × "R$"; "milhões de reais" → 1e6 × "R$"; "milhões" → 1e6 sem base.
 * Só no começo (após a moeda): em "por 100 mil hab." o "mil" não é escala.
 */
export function unitScale(unit: string | null | undefined): { base: string | null; factor: number } {
  if (!unit) return { base: null, factor: 1 };
  // "$" some na normalização: marca a moeda antes
  const u = normalizeText(unit.replace(/US\$/gi, " usd ").replace(/R\$/gi, " brl "));
  const m = u.match(/^(?:(brl|usd) )?(mil|mi|milhao|milhoes|bi|bilhao|bilhoes|tri|trilhao|trilhoes)(?: de)?(?: (.+))?$/);
  if (m) {
    const rest = [m[1], m[3]].filter(Boolean).join(" ");
    return { base: rest ? canonicalUnit(rest) : null, factor: SCALE_WORDS[m[2]!]! };
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

const CURRENCIES = ["R$", "US$"];
/** Multiplicadores que a extração costuma perder ou duplicar ("213" em vez de 213 milhões). */
const SCALE_SLIPS = [1e3, 1e6, 1e9, 1e12];

/**
 * Por que a série NÃO serve para a afirmação, só pela forma — unidade, período ×
 * periodicidade/agregação, tipo —, sem olhar os valores. null = serve.
 */
export function claimMismatch(ref: IndicatorRef, series: ComparableSeries): string | null {
  if (ref.claimed_value == null || !Number.isFinite(ref.claimed_value)) return "sem_valor_afirmado";
  const { base } = unitScale(series.unit);
  const seriesIsPercent = base === "%";
  const claim = unitScale(ref.unit);
  const claimUnit = claim.base;
  // número com escala ("5 milhões") não é taxa
  if (seriesIsPercent && claim.factor !== 1) return "unidade_incompativel";
  // unidade incompatível (ex.: afirmou R$ sobre série em %): não compara
  if (claimUnit) {
    if (seriesIsPercent && ref.kind !== "change_pct" && !["%", "p.p."].includes(claimUnit)) return "unidade_incompativel";
    if (!seriesIsPercent && ref.kind !== "change_pct" && (claimUnit === "%" || claimUnit === "p.p.")) return "unidade_incompativel";
    if (CURRENCIES.includes(claimUnit) && base !== claimUnit) return "unidade_incompativel";
    if (base && CURRENCIES.includes(base) && !CURRENCIES.includes(claimUnit) && claimUnit !== "%") return "unidade_incompativel";
  } else if (seriesIsPercent && ref.kind === "level" && Math.abs(ref.claimed_value) >= 1000) {
    // "8,5 milhões" sem unidade (desocupados) não é a taxa de desocupação
    return "unidade_incompativel";
  }

  const period = parsePeriod(ref.period);
  if (ref.period && !period) return "periodo_invalido";
  const aggregation = toAggregation(series.aggregation);
  if (ref.kind === "level") {
    if (period?.kind === "range") return "nivel_com_intervalo";
    if (!periodSupported(period, series.periodicity, aggregation)) return "periodo_incompativel";
  } else if (ref.kind === "change_abs" || ref.kind === "change_pct") {
    if (period?.kind !== "range" || !period.from || !period.to) return "variacao_sem_intervalo";
    if (!periodSupported(period.from, series.periodicity, aggregation) || !periodSupported(period.to, series.periodicity, aggregation)) {
      return "periodo_incompativel";
    }
  }
  return null;
}

/**
 * Compara o valor afirmado com a série oficial. Escolhe a leitura mais
 * favorável ao falante entre as plausíveis (média x último; p.p. x %;
 * com ou sem a escala dita) — o sistema só acusa quando nenhuma leitura
 * razoável sustenta a fala.
 */
export function compareIndicator(
  ref: IndicatorRef,
  series: ComparableSeries,
  values: IndicatorValue[],
): IndicatorComparison {
  const unfit = claimMismatch(ref, series);
  if (unfit) return noData(series, unfit, unfit === "sem_valor_afirmado" ? null : ref.claimed_value);
  const claimedRaw = ref.claimed_value!;
  if (!values.length) return noData(series, "serie_vazia", claimedRaw);

  const { base, factor } = unitScale(series.unit);
  const seriesIsPercent = base === "%";
  const claimScale = unitScale(ref.unit);
  const claimUnit = claimScale.base;
  const aggregation = toAggregation(series.aggregation);
  // valor afirmado com a escala dita ("213" + "milhões" → 213 mi); se havia escala, também
  // como veio (o extrator pode já ter aplicado o multiplicador)
  const readings = claimScale.factor !== 1 ? [claimedRaw * claimScale.factor, claimedRaw] : [claimedRaw];

  const period = parsePeriod(ref.period);
  const scaled = (v: number) => v * factor;
  const line = (label: string, v: number) => `${label} = ${fmt(v)} ${series.unit}`;
  const candidates: Candidate[] = [];

  if (ref.kind === "level") {
    for (const pv of valuesForPeriod(period, values, series.periodicity, aggregation)) {
      candidates.push({ actual: scaled(pv.value), isPercent: seriesIsPercent, lines: [line(pv.label, pv.value)] });
    }
  } else if (ref.kind === "change_abs" || ref.kind === "change_pct") {
    if (period?.kind !== "range" || !period.from || !period.to) return noData(series, "variacao_sem_intervalo", claimedRaw);
    const a = valuesForPeriod(period.from, values, series.periodicity, aggregation);
    const b = valuesForPeriod(period.to, values, series.periodicity, aggregation);
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
    if (!inside.length) return noData(series, "sem_dados_no_periodo", claimedRaw);
    const pick = inside.reduce((best, v) => ((ref.kind === "max" ? v.value > best.value : v.value < best.value) ? v : best));
    candidates.push({
      actual: scaled(pick.value), isPercent: seriesIsPercent,
      lines: [`${ref.kind === "max" ? "máximo" : "mínimo"} ${period ? `em ${period.label}` : "da série"}: ${line(valueLabel(pick), pick.value)}`],
    });
  }

  if (!candidates.length) return noData(series, "sem_dados_no_periodo", claimedRaw);

  // magnitude: a extração pode perder o sinal ("caiu 3 p.p." → 3); sinal explícito oposto é divergência
  const isChange = ref.kind === "change_abs" || ref.kind === "change_pct";
  let best: { status: Exclude<ComparisonStatus, "no_data">; c: Candidate; claimed: number; tol: number; diff: number } | null = null;
  for (const claimed of readings) {
    for (const c of candidates) {
      const signFlip = isChange && claimed < 0 && c.actual > 0;
      // variação afirmada sem sinal: compara magnitudes (a direção fica com o verificador)
      const effActual = isChange && claimed >= 0 ? Math.abs(c.actual) : c.actual;
      const tol = toleranceFor(c.isPercent, effActual);
      const status = signFlip ? "mismatch" : classify(claimed, effActual, tol);
      const diff = Math.abs(claimed - effActual) / (tol || 1);
      if (!best || STATUS_RANK[status] < STATUS_RANK[best.status] || (status === best.status && diff < best.diff)) {
        best = { status, c, claimed, tol, diff };
      }
    }
  }
  const b = best!;
  // número que só bate trocando mil/milhão/bilhão: a escala se perdeu na fala ou na extração
  if (b.status !== "match" && scaleSlip(readings, candidates, isChange)) return noData(series, "escala_incerta", b.claimed);
  return {
    status: b.status,
    expected_verdict: verdictForStatus(b.status),
    series_code: series.code,
    claimed: b.claimed,
    actual: b.c.actual,
    tolerance: b.tol,
    evidence_text: `Série ${series.name} (${series.source_name}): ${b.c.lines.join("; ")}`,
    reason: b.status,
  };
}

function scaleSlip(readings: number[], candidates: Candidate[], isChange: boolean): boolean {
  for (const c of candidates) {
    if (c.isPercent) continue;
    const effActual = isChange ? Math.abs(c.actual) : c.actual;
    const tol = toleranceFor(false, effActual);
    for (const r of readings) {
      for (const k of SCALE_SLIPS) {
        for (const x of [r * k, r / k]) {
          if (classify(isChange ? Math.abs(x) : x, effActual, tol) === "match") return true;
        }
      }
    }
  }
  return false;
}

function seriesFromMatch(m: IndicatorMatch): ComparableSeries {
  return {
    code: m.code, name: m.name, aliases: [], unit: m.unit, periodicity: m.periodicity,
    source_name: m.source_name, source_url: m.source_url, tier: m.tier as SourceTier, notes: null,
    // coluna aggregation de indicator_series, devolvida pelo find_indicator; ausente ⇒ "none"
    aggregation: toAggregation((m as IndicatorMatch & { aggregation?: unknown }).aggregation),
  };
}

/**
 * Busca a série pelo nome dito, carrega os valores e compara. A série só é usada se a
 * escolha for inequívoca: nome/alias exato (ou aproximado alto, com margem clara sobre a
 * 2ª) e, entre as que empatam, exatamente UMA compatível com a afirmação (unidade,
 * período × periodicidade/agregação, tipo). Ex.: "inflação" casa com IPCA mensal e 12
 * meses; "inflação de 2023" só cabe no acumulado (variação mensal não agrega em ano);
 * "inflação de março" cabe nas duas leituras ⇒ silêncio.
 */
export async function retrieveIndicator(
  ref: IndicatorRef,
  store: PipelineStore,
): Promise<{ comparison: IndicatorComparison; candidate: EvidenceCandidate | null }> {
  const none = (reason: string, s: IndicatorSeries | null = null) =>
    ({ comparison: noData(s, reason, ref.claimed_value), candidate: null });
  const matches = [...(await store.findIndicator(ref.query, INDICATOR_MATCH_COUNT))].sort((a, b) => b.score - a.score);
  const top = matches[0];
  if (!top || top.score < INDICATOR_MIN_SCORE) return none("serie_nao_encontrada");
  const contenders = matches
    .filter((m) => m.score >= Math.max(INDICATOR_MIN_SCORE, top.score - INDICATOR_MIN_MARGIN))
    .map(seriesFromMatch);
  if (top.score < INDICATOR_EXACT_SCORE && (top.score < INDICATOR_FUZZY_MIN_SCORE || contenders.length > 1)) {
    return none("serie_ambigua");
  }
  const fits = contenders.filter((s) => claimMismatch(ref, s) === null);
  if (fits.length > 1) return none("serie_ambigua");
  if (!fits.length) return none(claimMismatch(ref, contenders[0]!) ?? "serie_incompativel", contenders[0]!);
  const series = fits[0]!;
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
