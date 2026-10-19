// IBGE SIDRA. Duas portas para o mesmo banco:
//  1. API de Agregados v3 com view=flat — https://servicodados.ibge.gov.br/api/v3/agregados/...
//     Resposta no MESMO formato do apisidra (1ª linha = cabeçalho NC, NN, MN, V, D1C, D1N...).
//  2. apisidra — https://apisidra.ibge.gov.br/values/t/{t}/n1/all/v/{v}/p/all[/c{id}/{cat}]
// Segundo o pacote ibge-br-mcp (medição de 16/09/2026), o apisidra passou a ficar atrás
// de um desafio do Cloudflare (403 para clientes programáticos); por isso tentamos a v3 primeiro.
import { fetchJson } from "../lib/http";

export const AGREGADOS_BASE = "https://servicodados.ibge.gov.br/api/v3/agregados";
export const APISIDRA_BASE = "https://apisidra.ibge.gov.br/values";

export interface SidraQuery {
  table: string;
  variable: string;
  /** Ex.: "c11255/90707" (classificação/categoria), opcional. */
  classification?: string;
  /** Períodos: "all", "-12" (v3) / "last 12" (apisidra), intervalo "201201-202612". */
  periods?: string;
}

export function agregadosUrl(q: SidraQuery): string {
  const periods = q.periods ?? "all";
  let url = `${AGREGADOS_BASE}/${q.table}/periodos/${periods}/variaveis/${q.variable}?localidades=N1[all]`;
  if (q.classification) {
    const [cid, cat] = q.classification.split("/");
    url += `&classificacao=${cid!.replace(/^c/i, "")}[${cat}]`;
  }
  return `${url}&view=flat`;
}

export function apisidraUrl(q: SidraQuery): string {
  const periods = (q.periods ?? "all").replace(/^-(\d+)$/, "last%20$1");
  return `${APISIDRA_BASE}/t/${q.table}/n1/all/v/${q.variable}/p/${periods}${q.classification ? `/${q.classification}` : ""}`;
}

/** Página pública da tabela no SIDRA. */
export function sidraPublicUrl(table: string): string {
  return `https://sidra.ibge.gov.br/tabela/${table}`;
}

export interface SidraObservation {
  periodCode: string;
  periodLabel: string;
  value: number;
  unit: string | null;
}

const PERIOD_DIM = /^(m[eê]s|trimestre( m[oó]vel)?|ano|semestre)$/i;
const MISSING = new Set(["..", "...", "-", "X", "x", ""]);

/**
 * Formato "flat" (apisidra e v3 com view=flat): array de objetos; o primeiro é o
 * cabeçalho, que diz qual dimensão Dn é o período ("Mês", "Trimestre", "Trimestre Móvel", "Ano").
 */
export function parseSidraFlat(json: unknown): SidraObservation[] {
  if (!Array.isArray(json) || json.length === 0) throw new Error("resposta SIDRA vazia ou inesperada");
  const header = json[0] as Record<string, string>;
  let periodKey: string | null = null;
  for (const [k, label] of Object.entries(header)) {
    const m = /^D(\d+)N$/.exec(k);
    if (m && PERIOD_DIM.test(String(label).trim())) {
      periodKey = `D${m[1]}`;
      break;
    }
  }
  if (!periodKey) throw new Error(`cabeçalho SIDRA sem dimensão de período: ${JSON.stringify(header).slice(0, 200)}`);
  const out: SidraObservation[] = [];
  for (const row of json.slice(1) as Record<string, string>[]) {
    const raw = String(row.V ?? "").trim();
    if (MISSING.has(raw)) continue;
    const value = Number(raw.replace(",", "."));
    if (!Number.isFinite(value)) continue;
    out.push({
      periodCode: String(row[`${periodKey}C`]),
      periodLabel: String(row[`${periodKey}N`]),
      value,
      unit: row.MN ? String(row.MN) : null,
    });
  }
  return out;
}

/**
 * Formato aninhado da v3 (sem view=flat):
 * [{ id, variavel, unidade, resultados: [{ classificacoes, series: [{ localidade, serie: { "202401": "7.9" } }] }] }]
 */
export function parseAgregadosNested(json: unknown): SidraObservation[] {
  if (!Array.isArray(json)) throw new Error("resposta da API de agregados inesperada");
  const out: SidraObservation[] = [];
  for (const v of json as { unidade?: string; resultados?: { series?: { serie?: Record<string, string> }[] }[] }[]) {
    for (const r of v.resultados ?? []) {
      for (const s of r.series ?? []) {
        for (const [code, raw] of Object.entries(s.serie ?? {})) {
          const t = String(raw ?? "").trim();
          if (MISSING.has(t)) continue;
          const value = Number(t.replace(",", "."));
          if (Number.isFinite(value)) out.push({ periodCode: code, periodLabel: code, value, unit: v.unidade ?? null });
        }
      }
    }
  }
  return out;
}

/** Detecta o formato e interpreta. */
export function parseSidra(json: unknown): SidraObservation[] {
  if (Array.isArray(json) && json[0] && typeof json[0] === "object" && "resultados" in (json[0] as object)) {
    return parseAgregadosNested(json);
  }
  return parseSidraFlat(json);
}

export async function fetchSidra(q: SidraQuery): Promise<{ url: string; obs: SidraObservation[] }> {
  const errors: string[] = [];
  for (const url of [agregadosUrl(q), apisidraUrl(q)]) {
    try {
      const obs = parseSidra(await fetchJson(url, { timeoutMs: 60_000, retries: 2 }));
      return { url, obs };
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`SIDRA indisponível nas duas portas:\n  ${errors.join("\n  ")}`);
}
