// Regras simples de pessoa e tópico. Servem para filtrar e etiquetar a base;
// o pipeline não decide nada só com isto. Na dúvida, null.
import { normalizeForMatch } from "./text";

export const PERSONS = ["Lula", "Flávio Bolsonaro", "Jair Bolsonaro"] as const;
export type Person = (typeof PERSONS)[number];

const PERSON_RULES: { person: Person; patterns: RegExp[] }[] = [
  { person: "Flávio Bolsonaro", patterns: [/\bflavio bolsonaro\b/, /\bsenador flavio\b/, /\bflavio\b.*\bbolsonaro\b/] },
  { person: "Jair Bolsonaro", patterns: [/\bjair bolsonaro\b/, /\bjair messias\b/, /\bex-presidente bolsonaro\b/, /\bpresidente jair\b/] },
  { person: "Lula", patterns: [/\blula\b/, /\bluiz inacio\b/] },
];

/**
 * Pessoa citada. Ordem de confiança: quem fez a afirmação (claimant) > texto.
 * "Bolsonaro" sozinho é ambíguo em 2026 (Jair x Flávio) ⇒ null.
 */
export function detectPerson(...texts: (string | null | undefined)[]): Person | null {
  for (const t of texts) {
    if (!t) continue;
    const n = normalizeForMatch(t);
    const hits = PERSON_RULES.filter((r) => r.patterns.some((p) => p.test(n))).map((r) => r.person);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) {
      // mais de um nome: fica com o que aparece primeiro no texto
      const pos = (p: Person) =>
        Math.min(...PERSON_RULES.find((r) => r.person === p)!.patterns.map((re) => n.search(re)).filter((i) => i >= 0));
      return hits.sort((a, b) => pos(a) - pos(b))[0]!;
    }
  }
  return null;
}

/** Tópicos-guia do plano (slugs estáveis; o pipeline pode filtrar por eles). */
export const TOPICS = {
  economia: ["inflacao", "ipca", "pib", "desemprego", "desocupacao", "emprego", "juros", "selic", "dolar", "cambio", "divida publica", "deficit", "superavit", "salario minimo", "gasolina", "combustivel", "arcabouco fiscal", "teto de gastos", "economia"],
  impostos: ["imposto", "tributo", "tributaria", "imposto de renda", "isencao", "aliquota", "taxacao", "iof", "icms", "receita federal"],
  programas_sociais: ["bolsa familia", "auxilio brasil", "auxilio emergencial", "minha casa", "farmacia popular", "pe-de-meia", "beneficio social", "cadunico", "fome", "programa social"],
  seguranca: ["arma", "armamento", "seguranca publica", "homicidio", "violencia", "policia", "crime organizado", "faccao", "milicia", "trafico", "cac"],
  corrupcao_justica: ["corrupcao", "lava jato", "8 de janeiro", "golpe", "stf", "supremo", "tse", "condenad", "propina", "rachadinha", "inelegivel", "anistia", "prisao", "julgamento"],
  saude: ["saude", "vacina", "covid", "pandemia", "sus", "hospital", "medico", "mais medicos", "cloroquina"],
  meio_ambiente: ["desmatamento", "amazonia", "queimada", "meio ambiente", "clima", "garimpo", "prodes", "deter", "ibama", "cop30"],
  educacao: ["educacao", "escola", "universidade", "enem", "mec", "professor", "creche", "analfabetismo", "fies", "prouni"],
  politica_externa: ["politica externa", "venezuela", "china", "estados unidos", "eua", "trump", "israel", "russia", "ucrania", "mercosul", "brics", "itamaraty", "tarifa", "diplomacia"],
} as const;
export type Topic = keyof typeof TOPICS;

function matchCount(n: string, terms: readonly string[]): number {
  let c = 0;
  for (const t of terms) if (new RegExp(`\\b${t.replace(/[-]/g, "\\-")}`).test(n)) c++;
  return c;
}

/** Tópico mais citado (por número de termos distintos); empate ⇒ ordem da lista. */
export function detectTopic(...texts: (string | null | undefined)[]): Topic | null {
  return detectTopics(...texts)[0] ?? null;
}

export function detectTopics(...texts: (string | null | undefined)[]): Topic[] {
  const n = normalizeForMatch(texts.filter(Boolean).join(" \n "));
  return (Object.keys(TOPICS) as Topic[])
    .map((t) => ({ t, c: matchCount(n, TOPICS[t]) }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c)
    .map((x) => x.t);
}
