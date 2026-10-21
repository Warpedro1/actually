// indicators (L2): catálogo → indicator_series; valores → indicator_values.
//   --list               mostra o catálogo (ativas e pendentes) e sai
//   --only a,b           só essas séries
//   --since 2003-01-01   início da carga (padrão cobre Lula 1 em diante)
//   --include-pending    tenta também as pendentes que tenham fetch definido
//   --check              não grava; imprime os últimos valores e faz conferências cruzadas
//                        (móvel × trimestral; principal × reserva nas séries que têm reserva)
import type { IndicatorValue } from "@actually/db";
import { upsertRows, type Ctx } from "../lib/ctx";
import { activeSeries, CATALOG, describeFetch, toSeriesRow, type CatalogSeries, type SeriesFetch } from "../indicators/catalog";
import { manualSeriesRaw, parseManualSeries } from "../indicators/manual";
import { sgsPeriod, sidraPeriod } from "../indicators/periods";
import { aggregateMonthly, fetchSgs } from "../indicators/sgs";
import { fetchSidra } from "../indicators/sidra";

export interface IndicatorsOpts {
  list?: boolean;
  only?: string[];
  since?: string;
  includePending?: boolean;
  check?: boolean;
}

/** Portas de dados (trocadas nos testes, que não vão à rede). */
export interface Fetchers {
  sgs: typeof fetchSgs;
  sidra: typeof fetchSidra;
  /** Conteúdo de sources/manual/<file>.yaml. */
  manual: (file: string) => unknown;
}

export const DEFAULT_FETCHERS: Fetchers = { sgs: fetchSgs, sidra: fetchSidra, manual: manualSeriesRaw };

export interface LoadOptions {
  /** Aviso quando a principal falha e a reserva entra. */
  warn?: (msg: string) => void;
  fetchers?: Partial<Fetchers>;
}

/** Busca e converte os valores de UMA fonte da série (sem gravar e sem reserva). */
export async function loadFrom(
  s: CatalogSeries,
  f: SeriesFetch,
  since: string,
  until: string,
  fetchers: Partial<Fetchers> = {},
): Promise<IndicatorValue[]> {
  const fx = { ...DEFAULT_FETCHERS, ...fetchers };
  if (f.kind === "sgs") {
    let obs = await fx.sgs(f.code, { since, until, daily: Boolean(f.daily) });
    if (f.daily) obs = aggregateMonthly(obs, f.daily.aggregate);
    return obs.map((o) => {
      const [y, m, d] = o.date.split("-");
      return { series_code: s.code, ...sgsPeriod(`${d}/${m}/${y}`, s.periodicity), value: o.value, released_at: null };
    });
  }
  if (f.kind === "sidra") {
    const { obs } = await fx.sidra({ table: f.table, variable: f.variable, classification: f.classification });
    return obs
      .map((o) => ({ series_code: s.code, ...sidraPeriod(o.periodCode, s.periodicity), value: o.value, released_at: null }))
      .filter((v) => v.period_end >= since);
  }
  if (f.kind === "manual") {
    return parseManualSeries(fx.manual(f.file), s).filter((v) => v.period_end >= since);
  }
  throw new Error(`série ${s.code} sem fonte de dados definida`);
}

/** Valores carregados e de onde vieram. */
export interface LoadedSeries {
  values: IndicatorValue[];
  source: "principal" | "reserva";
}

/**
 * Busca e converte os valores de uma série (sem gravar). Se a principal falhar — ou não trouxer
 * nenhum valor — e a série tiver `fallback`, usa a reserva (mesmo dado, outra porta) e avisa.
 */
export async function loadSeries(s: CatalogSeries, since: string, until: string, opts: LoadOptions = {}): Promise<LoadedSeries> {
  let primaryError: string;
  try {
    const values = await loadFrom(s, s.fetch, since, until, opts.fetchers);
    if (values.length || !s.fallback) return { values, source: "principal" };
    primaryError = "nenhum valor no período";
  } catch (e) {
    if (!s.fallback) throw e;
    primaryError = (e as Error).message;
  }
  const main = describeFetch(s.fetch);
  const backup = describeFetch(s.fallback);
  opts.warn?.(`${s.code}: ${main} falhou (${primaryError}); usando a reserva ${backup}`);
  try {
    return { values: await loadFrom(s, s.fallback, since, until, opts.fetchers), source: "reserva" };
  } catch (e) {
    throw new Error(`${main}: ${primaryError} | reserva ${backup}: ${(e as Error).message}`);
  }
}

/** Como loadSeries, só os valores. */
export async function loadSeriesValues(s: CatalogSeries, since: string, until: string, opts: LoadOptions = {}): Promise<IndicatorValue[]> {
  return (await loadSeries(s, since, until, opts)).values;
}

export async function runIndicators(ctx: Ctx, opts: IndicatorsOpts): Promise<void> {
  if (opts.list) {
    for (const s of CATALOG) {
      const src = describeFetch(s.fetch) + (s.fallback ? ` (reserva ${describeFetch(s.fallback)})` : "");
      ctx.log(`${s.pending ? "PENDENTE" : "ativa   "}  ${s.code.padEnd(30)} ${s.periodicity.padEnd(15)} ${src.padEnd(22)} ${s.name}`);
      if (s.pending) ctx.log(`          motivo: ${s.pending}`);
    }
    return;
  }
  const since = opts.since ?? "2003-01-01";
  const until = new Date().toISOString().slice(0, 10);
  let series = activeSeries(opts.includePending).filter((s) => s.fetch.kind !== "none");
  if (opts.only?.length) series = series.filter((s) => opts.only!.includes(s.code));
  if (!series.length) throw new Error("nenhuma série selecionada (veja --list)");

  if (!opts.check) {
    try {
      await upsertRows(ctx, "indicator_series", series.map(toSeriesRow) as unknown as Record<string, unknown>[], "code");
    } catch (e) {
      throw withMigrationHint(e);
    }
  }
  const loaded = new Map<string, IndicatorValue[]>();
  const failures: string[] = [];
  for (const s of series) {
    try {
      const { values, source } = await loadSeries(s, since, until, { warn: ctx.warn });
      loaded.set(s.code, values);
      const last = values.at(-1);
      ctx.log(`${s.code}: ${values.length} valores${last ? `; último ${last.period_start}..${last.period_end} = ${last.value} ${s.unit}` : ""}`);
      if (opts.check) {
        for (const v of values.slice(-6)) ctx.log(`   ${v.period_start}..${v.period_end}  ${v.value}`);
        // com a reserva já em uso não há o que comparar (a principal falhou)
        if (s.fallback && source === "principal") await checkFallback(ctx, s, values, since, until);
      } else {
        await upsertRows(ctx, "indicator_values", values as unknown as Record<string, unknown>[], "series_code,period_start");
      }
    } catch (e) {
      failures.push(`${s.code}: ${(e as Error).message}`);
      ctx.warn(`${s.code}: falhou — ${(e as Error).message}`);
    }
  }
  if (opts.check) crossCheckUnemployment(ctx, loaded);
  if (failures.length) {
    ctx.warn(`${failures.length} série(s) falharam:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

/** --check: carrega a reserva e compara com o que veio (falha da reserva só avisa). */
async function checkFallback(ctx: Ctx, s: CatalogSeries, values: IndicatorValue[], since: string, until: string): Promise<void> {
  const backup = describeFetch(s.fallback!);
  try {
    const other = await loadFrom(s, s.fallback!, since, until);
    compareSources(ctx, `${s.code} (${describeFetch(s.fetch)} × ${backup})`, values, other);
  } catch (e) {
    ctx.warn(`${s.code}: reserva ${backup} indisponível — ${(e as Error).message}`);
  }
}

/**
 * Principal × reserva da mesma série: mesmos períodos têm de ter o mesmo valor. Diferença
 * indica rótulo de período deslocado (ex.: trimestre móvel datado pelo 1º mês) ou série trocada.
 */
export function compareSources(ctx: Pick<Ctx, "log" | "warn">, label: string, a: IndicatorValue[], b: IndicatorValue[]): number {
  const byStart = new Map(b.map((v) => [v.period_start, v]));
  let compared = 0;
  let mismatches = 0;
  for (const v of a) {
    const w = byStart.get(v.period_start);
    if (!w) continue;
    compared++;
    if (w.period_end !== v.period_end || Math.abs(w.value - v.value) > 0.05) {
      mismatches++;
      ctx.warn(`${label} ${v.period_start}..${v.period_end}: ${v.value} × ${w.period_start}..${w.period_end}: ${w.value}`);
    }
  }
  ctx.log(`conferência ${label}: ${compared} períodos comparados, ${mismatches} divergências`);
  return mismatches;
}

/** Migration que criou indicator_series.aggregation (o catálogo grava a coluna). */
export const AGGREGATION_MIGRATION = "supabase/migrations/20261019000007_indicator_aggregation.sql";

/** Banco sem a coluna `aggregation` (PostgREST: "Could not find the 'aggregation' column"): diz o que fazer. */
export function withMigrationHint(e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (!/aggregation/.test(err.message)) return err;
  return new Error(`${err.message} — aplique ${AGGREGATION_MIGRATION} no Supabase e rode \`indicators\` de novo`);
}

/**
 * Conferência cruzada: o trimestre móvel terminado em mar/jun/set/dez (SIDRA 6381, ou a
 * reserva SGS 24369) tem de bater com o trimestre civil da tabela 4099 do SIDRA. Diferença indica
 * rótulo de período errado ou série trocada.
 */
export function crossCheckUnemployment(ctx: Pick<Ctx, "log" | "warn">, loaded: Map<string, IndicatorValue[]>): number {
  const movel = loaded.get("desocupacao_pnadc_movel");
  const trim = loaded.get("desocupacao_pnadc_trimestral");
  if (!movel || !trim) return 0;
  const byStart = new Map(trim.map((v) => [v.period_start, v.value]));
  let compared = 0;
  let mismatches = 0;
  for (const v of movel) {
    const q = byStart.get(v.period_start);
    if (q === undefined || !/-(01|04|07|10)-01$/.test(v.period_start)) continue;
    compared++;
    if (Math.abs(q - v.value) > 0.05) {
      mismatches++;
      ctx.warn(`desocupação ${v.period_start}: móvel=${v.value} trimestral=${q}`);
    }
  }
  ctx.log(`conferência desocupação (móvel × trimestral): ${compared} trimestres comparados, ${mismatches} divergências`);
  return mismatches;
}
