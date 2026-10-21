// Fatos de referência (camada L2): mandatos presidenciais e resultados oficiais
// de eleição, curados com fonte (migration 0012). A conta é feita aqui, em
// código — "o PT governou 20 dos últimos 24 anos" vira a soma dos mandatos —
// porque nenhuma fonte escreve "17,4 dos últimos 24 anos" e a regra de números
// da correção (só números presentes na evidência) barraria um valor calculado.
// O texto da evidência é gerado aqui e contém o número calculado.
import { tierForUrl, type RefElection, type RefMandate, type Verdict } from "@actually/db";
import { REFERENCE_TOLERANCE } from "../config";
import { normalizeText } from "../normalize";
import type { PipelineStore } from "../store";
import type { ComparisonStatus, EvidenceCandidate, IndicatorComparison, ReferenceRef } from "../types";

const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;

/** Siglas e nomes de partido como podem ser ditos → sigla gravada. */
const PARTY_ALIASES: Record<string, string> = {
  pt: "PT", "partido dos trabalhadores": "PT",
  psdb: "PSDB",
  mdb: "MDB", pmdb: "MDB", "movimento democratico brasileiro": "MDB",
  pl: "PL", "partido liberal": "PL",
  psl: "PSL",
};
/** Apelidos que não são parte do nome completo. */
const PERSON_ALIASES: Record<string, string> = {
  fhc: "fernando henrique cardoso",
};

const verdictFor = (s: ComparisonStatus): Verdict | null =>
  s === "match" ? "confirmado" : s === "minor_mismatch" ? "impreciso" : s === "mismatch" ? "contradito" : null;

function noData(reason: string, claimed: number | null): IndicatorComparison {
  return {
    status: "no_data", expected_verdict: null, series_code: null, claimed, actual: null, tolerance: null,
    evidence_text: null, reason,
  };
}

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
};
const fmtNum = (v: number, digits: number) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Todas as palavras do que foi dito aparecem no nome completo ("Lula" ⊂ "Luiz Inácio Lula da Silva"). */
export function samePerson(said: string, fullName: string): boolean {
  const n = normalizeText(said);
  const target = normalizeText(PERSON_ALIASES[n] ?? n).split(" ").filter(Boolean);
  const words = new Set(normalizeText(fullName).split(" "));
  return target.length > 0 && target.every((w) => words.has(w));
}

export function partyFor(said: string): string | null {
  return PARTY_ALIASES[normalizeText(said)] ?? null;
}

/**
 * Status pela distância entre o dito e o oficial, respeitando o qualificador
 * ("mais de 50 milhões" com 58 milhões está certo).
 */
export function compareValue(
  claimed: number,
  actual: number,
  qualifier: ReferenceRef["qualifier"],
  tol: { match: number; minor: number },
): ComparisonStatus {
  if (qualifier === "mais_de" && actual >= claimed) return "match";
  if (qualifier === "menos_de" && actual <= claimed) return "match";
  if (qualifier === "quase" && actual <= claimed && claimed - actual <= tol.minor) return "match";
  const diff = Math.abs(claimed - actual);
  if (diff <= tol.match) return "match";
  if (diff <= tol.minor) return "minor_mismatch";
  return "mismatch";
}

/** Dias de [a1,a2) dentro de [b1,b2). */
function overlapDays(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)) / DAY_MS;
}

export function timeInPower(
  ref: ReferenceRef,
  mandates: RefMandate[],
  asOf: string,
): { comparison: IndicatorComparison; rows: RefMandate[] } {
  const party = partyFor(ref.subject);
  const rows = mandates
    .filter((m) => (party ? m.partido.toUpperCase() === party : samePerson(ref.subject, m.pessoa)))
    .sort((a, b) => a.inicio.localeCompare(b.inicio));
  if (!rows.length) return { comparison: noData("referencia_nao_encontrada", ref.claimed_value), rows };

  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = ref.window_years ? end - ref.window_years * YEAR_DAYS * DAY_MS : Number.NEGATIVE_INFINITY;
  let days = 0;
  const used: RefMandate[] = [];
  for (const m of rows) {
    const d = overlapDays(Date.parse(`${m.inicio}T00:00:00Z`), m.fim ? Date.parse(`${m.fim}T00:00:00Z`) : end, start, end);
    if (d > 0) {
      days += d;
      used.push(m);
    }
  }
  const actual = Math.round((days / YEAR_DAYS) * 10) / 10;
  const tol = { match: REFERENCE_TOLERANCE.years_match, minor: Math.max(REFERENCE_TOLERANCE.years_match, actual * REFERENCE_TOLERANCE.years_minor_frac) };
  // Sem janela ("Lula governou 8 anos", "os 13 anos do PT"), a fala pode ser sobre só parte
  // do tempo total (os dois primeiros mandatos, um período citado no contexto): valor abaixo
  // do total não é acusável — silêncio. Só o exagero acima do máximo possível é.
  if (!ref.window_years && ref.claimed_value < actual - tol.match) {
    return { comparison: noData("parte_do_total", ref.claimed_value), rows };
  }
  const status = compareValue(ref.claimed_value, actual, ref.qualifier, tol);
  const who = party ? `do ${party}` : `de ${rows[0]!.pessoa}`;
  const listed = used.length ? used : rows;
  const lines = listed.map((m) =>
    `${m.pessoa} (${m.partido}${m.papel === "interino" ? ", interino" : ""}), de ${fmtDate(m.inicio)} a ${m.fim ? fmtDate(m.fim) : "hoje"}`);
  // janela e valor arredondado escritos por extenso: a correção costuma citá-los
  // ("17 anos nos últimos 24") e a trava de números exige que estejam na evidência
  const since = Number.isFinite(start)
    ? `nos últimos ${fmtNum(ref.window_years!, Number.isInteger(ref.window_years) ? 0 : 1)} anos (de ${fmtDate(new Date(start).toISOString())} a ${fmtDate(asOf)})`
    : `até ${fmtDate(asOf)}`;
  const evidence_text =
    `Mandatos na Presidência da República (${listed[0]!.fonte_nome}): ${lines.join("; ")}. ` +
    `Tempo ${who} na Presidência ${since}: ${fmtNum(actual, 1)} anos, cerca de ${Math.round(actual)} anos ` +
    `(cálculo do actually a partir das datas oficiais).`;
  return {
    comparison: {
      status, expected_verdict: verdictFor(status), series_code: "ref_mandatos", claimed: ref.claimed_value,
      actual, tolerance: tol.match, evidence_text, reason: used.length ? "ok" : "fora_da_janela",
    },
    rows: listed,
  };
}

export function electionResult(
  ref: ReferenceRef,
  rows: RefElection[],
): { comparison: IndicatorComparison; row: RefElection | null } {
  const found = rows.filter((r) => samePerson(ref.subject, r.candidato));
  if (found.length !== 1) {
    return { comparison: noData(found.length ? "candidato_ambiguo" : "referencia_nao_encontrada", ref.claimed_value), row: null };
  }
  const r = found[0]!;
  const isPct = ref.unit === "%";
  const actual = isPct ? r.pct_validos : r.votos;
  // escala trocada ("58" dito como 58 milhões) não é erro do falante: silêncio
  if (isPct ? ref.claimed_value > 100 : actual > 0 && (ref.claimed_value / actual < 0.05 || ref.claimed_value / actual > 20)) {
    return { comparison: noData("escala_incompativel", ref.claimed_value), row: null };
  }
  const tol = isPct
    ? { match: REFERENCE_TOLERANCE.pct_match_pp, minor: REFERENCE_TOLERANCE.pct_minor_pp }
    : { match: actual * REFERENCE_TOLERANCE.votes_match_frac, minor: actual * REFERENCE_TOLERANCE.votes_minor_frac };
  const status = compareValue(ref.claimed_value, actual, ref.qualifier, tol);
  const evidence_text =
    `Eleição presidencial de ${r.ano}, ${r.turno}º turno (${r.fonte_nome}): ${r.candidato} (${r.partido}) teve ` +
    `${r.votos.toLocaleString("pt-BR")} votos, ${fmtNum(r.pct_validos, 2)}% dos votos válidos${r.eleito ? ", e foi eleito" : ""}.`;
  return {
    comparison: {
      status, expected_verdict: verdictFor(status), series_code: "ref_eleicoes", claimed: ref.claimed_value,
      actual, tolerance: tol.match, evidence_text, reason: "ok",
    },
    row: r,
  };
}

/** Camada L2 para fatos de referência: comparação determinística + evidência gerada. */
export async function retrieveReference(
  ref: ReferenceRef,
  store: PipelineStore,
  asOf: string,
): Promise<{ comparison: IndicatorComparison; candidate: EvidenceCandidate | null }> {
  if (!store.refMandates || !store.refElections) return { comparison: noData("sem_referencias", ref.claimed_value), candidate: null };
  let comparison: IndicatorComparison;
  let source: { url: string; name: string; title: string } | null = null;
  if (ref.type === "tempo_no_poder") {
    if (ref.unit !== "anos") return { comparison: noData("unidade_incompativel", ref.claimed_value), candidate: null };
    const r = timeInPower(ref, await store.refMandates(), asOf);
    comparison = r.comparison;
    const first = r.rows[0];
    if (first) source = { url: first.fonte_url, name: first.fonte_nome, title: "Mandatos na Presidência da República" };
  } else {
    if (!ref.year || !ref.round || ref.unit === "anos") return { comparison: noData("eleicao_incompleta", ref.claimed_value), candidate: null };
    const r = electionResult(ref, await store.refElections(ref.year, ref.round));
    comparison = r.comparison;
    if (r.row) source = { url: r.row.fonte_url, name: r.row.fonte_nome, title: `Eleição presidencial de ${r.row.ano}, ${r.row.turno}º turno` };
  }
  if (comparison.status === "no_data" || !comparison.evidence_text || !source) return { comparison, candidate: null };
  return {
    comparison,
    candidate: {
      layer: "L2",
      evidence_type: "indicator",
      url: source.url,
      source_name: source.name,
      // o nível vem do endereço da fonte, como nas outras camadas (nível 4 nunca sustenta alerta)
      source_tier: tierForUrl(source.url),
      published_at: null,
      title: source.title,
      text: comparison.evidence_text,
      relevance: 1,
      comparison,
    },
  };
}
