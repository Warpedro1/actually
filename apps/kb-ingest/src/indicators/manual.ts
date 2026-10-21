// Séries manuais da L2: valores copiados da publicação oficial para um YAML versionado
// (sources/manual/<arquivo>.yaml), quando a fonte não tem API nem arquivo estável. O YAML
// vai embutido em src/generated/sources.ts (a Vercel não lê o disco): `gen:sources`.
//
// As regras são conferidas AQUI, não só na revisão — um valor fora delas recusa o arquivo
// inteiro e a série fica sem carga (silêncio na L2), nunca com dado sem fonte:
//   - cada valor tem a URL da publicação e diz como foi conferido;
//   - URL de nível 1 (oficial) basta; de nível 2 (imprensa de referência) só com `confirmed_by`
//     de outro domínio também de nível 2; nível 3–4 nunca;
//   - período no formato da periodicidade da série e sem repetição;
//   - `series` e `unit` iguais aos do catálogo (arquivo trocado não carrega).
import { lookupSource, type IndicatorValue } from "@actually/db";
import { z } from "zod";
import { MANUAL_SERIES_RAW } from "../generated/sources";
import type { CatalogSeries } from "./catalog";
import { monthPeriod, movingQuarterPeriod, quarterPeriod, yearPeriod, type Period, type Periodicity } from "./periods";

const httpUrl = z.string().regex(/^https?:\/\//, "url precisa ser http(s)");

export const ManualValue = z.object({
  /** "2025" (anual), "2025-03" (mensal / trimestre móvel terminado no mês), "2025-T1" (trimestral). */
  period: z.union([z.string(), z.number()]).transform((v) => String(v).trim()),
  value: z.number(),
  url: httpUrl,
  /** Segunda fonte, exigida quando `url` é de nível 2. */
  confirmed_by: httpUrl.nullish(),
  released_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "released_at no formato AAAA-MM-DD").nullish(),
  source: z.string().min(1),
  verified_by: z.string().min(1),
});
export type ManualValue = z.infer<typeof ManualValue>;

export const ManualSeriesFile = z.object({
  series: z.string().min(1),
  unit: z.string().min(1),
  values: z.array(ManualValue).min(1),
});

/** Período de um valor manual conforme a periodicidade da série. */
export function manualPeriod(p: string, periodicity: Periodicity): Period {
  let m: RegExpExecArray | null;
  switch (periodicity) {
    case "annual":
      if ((m = /^(\d{4})$/.exec(p))) return yearPeriod(Number(m[1]));
      break;
    case "monthly":
      if ((m = /^(\d{4})-(\d{2})$/.exec(p))) return monthPeriod(Number(m[1]), Number(m[2]));
      break;
    case "moving_quarter":
      if ((m = /^(\d{4})-(\d{2})$/.exec(p))) return movingQuarterPeriod(Number(m[1]), Number(m[2]));
      break;
    case "quarterly":
      if ((m = /^(\d{4})-T([1-4])$/i.exec(p))) return quarterPeriod(Number(m[1]), Number(m[2]));
      break;
  }
  throw new Error(`período "${p}" inválido para série ${periodicity}`);
}

/** Por que a fonte de um valor não basta (null = basta). */
export function sourceProblem(v: Pick<ManualValue, "url" | "confirmed_by">): string | null {
  const main = lookupSource(v.url);
  if (main?.tier === 1) return null;
  if (main?.tier !== 2) return `${v.url} não é fonte de nível 1 ou 2 (source_tiers)`;
  if (!v.confirmed_by) return `${v.url} é de nível 2: falta confirmed_by (segunda fonte de nível 2)`;
  const second = lookupSource(v.confirmed_by);
  if (second?.tier !== 2 && second?.tier !== 1) return `confirmed_by ${v.confirmed_by} não é fonte de nível 1 ou 2`;
  if (second.domain === main.domain) return `confirmed_by ${v.confirmed_by} é do mesmo veículo de ${v.url}`;
  return null;
}

/** Conteúdo de um sources/manual/<arquivo>.yaml → indicator_values. Lança se fugir das regras. */
export function parseManualSeries(raw: unknown, s: Pick<CatalogSeries, "code" | "unit" | "periodicity">): IndicatorValue[] {
  const parsed = ManualSeriesFile.safeParse(raw);
  if (!parsed.success) throw new Error(`série manual ${s.code} inválida: ${parsed.error.message}`);
  const f = parsed.data;
  if (f.series !== s.code) throw new Error(`arquivo da série ${f.series}, esperado ${s.code}`);
  if (f.unit !== s.unit) throw new Error(`série manual ${s.code}: unidade "${f.unit}" ≠ catálogo "${s.unit}"`);
  const seen = new Set<string>();
  const out: IndicatorValue[] = [];
  for (const v of f.values) {
    const problem = sourceProblem(v);
    if (problem) throw new Error(`série manual ${s.code}, ${v.period}: ${problem}`);
    const period = manualPeriod(v.period, s.periodicity);
    if (seen.has(period.period_start)) throw new Error(`série manual ${s.code}: período ${v.period} repetido`);
    seen.add(period.period_start);
    out.push({ series_code: s.code, ...period, value: v.value, released_at: v.released_at ?? null });
  }
  return out.sort((a, b) => a.period_start.localeCompare(b.period_start));
}

/** Arquivo embutido (src/generated/sources.ts) da série manual. */
export function manualSeriesRaw(file: string): unknown {
  if (!(file in MANUAL_SERIES_RAW)) {
    throw new Error(`sources/manual/${file}.yaml não está embutido (rode \`pnpm --filter @actually/kb-ingest gen:sources\`)`);
  }
  return MANUAL_SERIES_RAW[file];
}
