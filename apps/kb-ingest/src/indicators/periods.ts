// Resolução de períodos → [period_start, period_end] (datas ISO, fim inclusivo).
//   mensal          2024-09            → 2024-09-01 .. 2024-09-30
//   trimestral      2024 T2 (SIDRA 202402) → 2024-04-01 .. 2024-06-30
//   trimestre móvel jul-ago-set 2024 (SIDRA 202409, rotulado pelo último mês) → 2024-07-01 .. 2024-09-30
//   anual           2024               → 2024-01-01 .. 2024-12-31
import type { IndicatorSeries } from "@actually/db";

export type Periodicity = IndicatorSeries["periodicity"];

export interface Period {
  period_start: string;
  period_end: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthPeriod(y: number, m: number): Period {
  assertMonth(m);
  return { period_start: iso(y, m, 1), period_end: iso(y, m, lastDayOfMonth(y, m)) };
}

export function quarterPeriod(y: number, q: number): Period {
  if (q < 1 || q > 4) throw new Error(`trimestre inválido: ${q}`);
  const m0 = (q - 1) * 3 + 1;
  return { period_start: iso(y, m0, 1), period_end: iso(y, m0 + 2, lastDayOfMonth(y, m0 + 2)) };
}

/** Trimestre móvel terminado no mês `m` do ano `y`. */
export function movingQuarterPeriod(y: number, m: number): Period {
  assertMonth(m);
  let sy = y;
  let sm = m - 2;
  if (sm < 1) {
    sm += 12;
    sy -= 1;
  }
  return { period_start: iso(sy, sm, 1), period_end: iso(y, m, lastDayOfMonth(y, m)) };
}

export function yearPeriod(y: number): Period {
  return { period_start: iso(y, 1, 1), period_end: iso(y, 12, 31) };
}

function assertMonth(m: number) {
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error(`mês inválido: ${m}`);
}

/** Código de período do SIDRA ("2024", "202409", "202402") conforme a periodicidade da série. */
export function sidraPeriod(code: string, periodicity: Periodicity): Period {
  const c = code.trim();
  if (periodicity === "annual") {
    if (!/^\d{4}$/.test(c)) throw new Error(`período anual inválido: ${code}`);
    return yearPeriod(Number(c));
  }
  if (!/^\d{6}$/.test(c)) throw new Error(`período SIDRA inválido: ${code}`);
  const y = Number(c.slice(0, 4));
  const n = Number(c.slice(4));
  switch (periodicity) {
    case "monthly":
      return monthPeriod(y, n);
    case "quarterly":
      return quarterPeriod(y, n);
    case "moving_quarter":
      return movingQuarterPeriod(y, n);
  }
}

/** Data do SGS ("dd/MM/yyyy") → componentes. */
export function parseSgsDate(d: string): { y: number; m: number; day: number } {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.trim());
  if (!m) throw new Error(`data SGS inválida: ${d}`);
  return { day: Number(m[1]), m: Number(m[2]), y: Number(m[3]) };
}

/**
 * Período de uma observação do SGS. Séries mensais/trimestrais/anuais do SGS
 * datam a observação no 1º dia do período. Para trimestre móvel (ex.: a
 * desocupação PNADC espelhada no SGS), a data é o último mês do trimestre.
 */
export function sgsPeriod(date: string, periodicity: Periodicity): Period {
  const { y, m } = parseSgsDate(date);
  switch (periodicity) {
    case "monthly":
      return monthPeriod(y, m);
    case "moving_quarter":
      return movingQuarterPeriod(y, m);
    case "quarterly":
      return quarterPeriod(y, Math.floor((m - 1) / 3) + 1);
    case "annual":
      return yearPeriod(y);
  }
}

/** "yyyy-MM-dd" → "dd/MM/yyyy" (parâmetros dataInicial/dataFinal do SGS). */
export function toSgsDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error(`data ISO inválida: ${isoDate}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}
