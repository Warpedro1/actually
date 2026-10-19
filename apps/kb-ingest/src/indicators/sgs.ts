// BCB SGS — https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json
// Formato: [{"data":"01/07/2021","valor":"0.96"}, ...] (valor em string, ponto decimal).
// Limites medidos por terceiros (pacote bcb-br-mcp, 08/2026): série DIÁRIA só aceita
// janela ≤ 10 anos (erro 406) e janelas longas estouram o tempo — fatiamos em 3 anos.
import { fetchJson } from "../lib/http";
import { parseSgsDate, toSgsDate } from "./periods";

export const SGS_BASE = "https://api.bcb.gov.br/dados/serie/bcdata.sgs";

export interface SgsObservation {
  /** yyyy-MM-dd */
  date: string;
  value: number;
}

export function sgsUrl(code: number, dataInicial?: string, dataFinal?: string): string {
  const qs = new URLSearchParams({ formato: "json" });
  if (dataInicial) qs.set("dataInicial", toSgsDate(dataInicial));
  if (dataFinal) qs.set("dataFinal", toSgsDate(dataFinal));
  return `${SGS_BASE}.${code}/dados?${qs.toString()}`;
}

/** URL pública da série (a própria consulta na API do SGS; vale como evidência). */
export function sgsPublicUrl(code: number): string {
  return `${SGS_BASE}.${code}/dados?formato=json`;
}

/** Interpreta a resposta do SGS. Lança se não for a lista esperada. */
export function parseSgs(json: unknown): SgsObservation[] {
  if (!Array.isArray(json)) {
    const msg = json && typeof json === "object" ? JSON.stringify(json).slice(0, 200) : String(json);
    throw new Error(`resposta inesperada do SGS: ${msg}`);
  }
  const out: SgsObservation[] = [];
  for (const row of json) {
    if (!row || typeof row !== "object") continue;
    const { data, valor } = row as { data?: unknown; valor?: unknown };
    if (typeof data !== "string" || valor === null || valor === undefined || valor === "") continue;
    const v = Number(String(valor).replace(",", "."));
    if (!Number.isFinite(v)) continue;
    const { y, m, day } = parseSgsDate(data);
    out.push({ date: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`, value: v });
  }
  return out;
}

/**
 * Série diária → uma observação por mês. "last" = último valor do mês
 * (ex.: meta Selic vigente no fim do mês) — é um valor publicado, não uma conta.
 * "mean" = média aritmética (derivado; só use se a série for descrita assim).
 */
export function aggregateMonthly(obs: SgsObservation[], how: "last" | "mean"): SgsObservation[] {
  const byMonth = new Map<string, SgsObservation[]>();
  for (const o of [...obs].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = o.date.slice(0, 7);
    const arr = byMonth.get(key) ?? [];
    arr.push(o);
    byMonth.set(key, arr);
  }
  return [...byMonth.entries()].map(([month, arr]) => ({
    date: `${month}-01`,
    value: how === "last" ? arr[arr.length - 1]!.value : arr.reduce((s, o) => s + o.value, 0) / arr.length,
  }));
}

/** Janelas [ini, fim] de no máximo `years` anos (sem sobreposição). */
export function dateWindows(startIso: string, endIso: string, years: number): [string, string][] {
  const out: [string, string][] = [];
  let cur = new Date(`${startIso}T00:00:00Z`);
  const end = new Date(`${endIso}T00:00:00Z`);
  while (cur <= end) {
    const next = new Date(cur);
    next.setUTCFullYear(next.getUTCFullYear() + years);
    next.setUTCDate(next.getUTCDate() - 1);
    const wEnd = next < end ? next : end;
    out.push([cur.toISOString().slice(0, 10), wEnd.toISOString().slice(0, 10)]);
    cur = new Date(wEnd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export async function fetchSgs(code: number, opts: { since: string; until: string; daily: boolean }): Promise<SgsObservation[]> {
  const windows = opts.daily ? dateWindows(opts.since, opts.until, 3) : [[opts.since, opts.until] as [string, string]];
  const all: SgsObservation[] = [];
  for (const [a, b] of windows) {
    all.push(...parseSgs(await fetchJson(sgsUrl(code, a, b), { timeoutMs: 45_000 })));
  }
  // emendas de janelas não se sobrepõem, mas deduplica por segurança
  const seen = new Set<string>();
  return all.filter((o) => (seen.has(o.date) ? false : (seen.add(o.date), true)));
}
