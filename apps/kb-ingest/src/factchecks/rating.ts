// Rating textual das agências → veredito do sistema.
// Tabela explícita (e testada). Princípio: só "contradito" quando a agência
// diz que é falso; nuance (enganoso, exagerado, sem contexto...) vira "impreciso";
// qualquer coisa que não seja juízo sobre a veracidade, ou que não conhecemos,
// vira "inconclusivo". Na dúvida, inconclusivo.
import type { Verdict } from "@actually/db";
import { normalizeForMatch } from "../lib/text";

/** Rótulos exatos (normalizados: minúsculas, sem acento, sem pontuação final). */
export const RATING_TABLE: Record<string, Verdict> = {
  // contradito
  falso: "contradito",
  falsa: "contradito",
  fake: "contradito",
  "#fake": "contradito",
  "e fake": "contradito",
  "e #fake": "contradito",
  "e falso": "contradito",
  "e falsa": "contradito",
  mentira: "contradito",
  montagem: "contradito",
  "foto montada": "contradito",
  "video manipulado": "contradito",
  "imagem manipulada": "contradito",
  "nao e verdade": "contradito",
  "nao procede": "contradito",
  // impreciso
  enganoso: "impreciso",
  enganosa: "impreciso",
  "e enganoso": "impreciso",
  distorcido: "impreciso",
  distorcida: "impreciso",
  exagerado: "impreciso",
  exagerada: "impreciso",
  subestimado: "impreciso",
  "sem contexto": "impreciso",
  "fora de contexto": "impreciso",
  "falta contexto": "impreciso",
  impreciso: "impreciso",
  imprecisa: "impreciso",
  "parcialmente falso": "impreciso",
  "parcialmente falsa": "impreciso",
  "parcialmente verdadeiro": "impreciso",
  "meia verdade": "impreciso",
  "verdadeiro, mas": "impreciso",
  "verdadeiro mas": "impreciso",
  "nao e bem assim": "impreciso",
  "e #nao e bem assim": "impreciso",
  "#nao e bem assim": "impreciso",
  // confirmado
  verdadeiro: "confirmado",
  verdadeira: "confirmado",
  verdade: "confirmado",
  "e verdade": "confirmado",
  "e verdadeiro": "confirmado",
  fato: "confirmado",
  "#fato": "confirmado",
  "e fato": "confirmado",
  "e #fato": "confirmado",
  comprovado: "confirmado",
  correto: "confirmado",
  // inconclusivo — não é juízo de veracidade, ou falta base
  insustentavel: "inconclusivo",
  contraditorio: "inconclusivo",
  "de olho": "inconclusivo",
  "ainda e cedo para dizer": "inconclusivo",
  "sem evidencias": "inconclusivo",
  "sem provas": "inconclusivo",
  "nao comprovado": "inconclusivo",
  satira: "inconclusivo",
  contextualizando: "inconclusivo",
  "em analise": "inconclusivo",
};

/**
 * Prefixos para ratings longos ("Falso. O vídeo mostra..." ou "Enganoso: ...").
 * A ORDEM importa: os mais específicos primeiro ("verdadeiro, mas" antes de
 * "verdadeiro"; "parcialmente falso" antes de "falso").
 */
const PREFIX_RULES: [string, Verdict][] = [
  ["verdadeiro, mas", "impreciso"],
  ["verdadeiro mas", "impreciso"],
  ["parcialmente falso", "impreciso"],
  ["parcialmente falsa", "impreciso"],
  ["parcialmente verdadeiro", "impreciso"],
  ["nao e bem assim", "impreciso"],
  ["sem contexto", "impreciso"],
  ["fora de contexto", "impreciso"],
  ["enganos", "impreciso"],
  ["distorcid", "impreciso"],
  ["exagerad", "impreciso"],
  ["imprecis", "impreciso"],
  ["subestimad", "impreciso"],
  ["insustentavel", "inconclusivo"],
  ["contraditori", "inconclusivo"],
  ["satira", "inconclusivo"],
  ["falso", "contradito"],
  ["falsa", "contradito"],
  ["fake", "contradito"],
  ["montagem", "contradito"],
  ["verdadeir", "confirmado"],
  ["comprovad", "confirmado"],
];

export function normalizeRating(rating: string): string {
  return normalizeForMatch(rating)
    // selo que chega como slug do feed ("não_é_bem_assim", "parcialmente-falso"): o separador
    // vira espaço, senão o rótulo não casa com a tabela nem com os prefixos e cai em
    // inconclusivo — 25 checagens da base ficaram assim.
    .replace(/[_\-–—]+/g, " ")
    .replace(/^[\s"'(\[]+|[\s"')\].!:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mapeia o rating textual para o veredito. Desconhecido ⇒ inconclusivo. */
export function mapRating(rating: string | null | undefined): Verdict {
  if (!rating) return "inconclusivo";
  const n = normalizeRating(rating);
  const exact = RATING_TABLE[n];
  if (exact) return exact;
  // "É falso que..." / "Falso: ..." — testa o início (com e sem "e " inicial)
  for (const candidate of [n, n.replace(/^e\s+/, "").replace(/^#/, "")]) {
    for (const [prefix, verdict] of PREFIX_RULES) {
      // prefixos são radicais ("enganos" casa enganoso/enganosa)
      if (candidate.startsWith(prefix)) {
        // "nao e falso" e similares não podem cair em "falso"
        if (/^nao\b/.test(candidate)) return "inconclusivo";
        return verdict;
      }
    }
  }
  return "inconclusivo";
}

/**
 * Rating a partir do título, nos formatos que as agências usam
 * ("É falso que...", "É #FAKE que...", "Enganoso: ...").
 * Devolve o rótulo como aparece no título, ou null.
 */
export function ratingFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title.trim();
  const m =
    /^(?:é\s+)?(#?fake|#?fato|#?não é bem assim|falso|falsa|enganos[oa]|verdadeir[oa](?:,? mas)?|exagerad[oa]|distorcid[oa]|insustentável|sem contexto|montagem|sátira)\b(?=\s+que\b|\s*[:|–—-])/i.exec(
      t,
    );
  return m ? m[1]! : null;
}

/**
 * Rating declarado em linha própria no texto ("Classificação: Falso",
 * "Etiqueta: Enganoso", "Selo: Falso"). Só reconhece rótulos da tabela.
 * Mais de uma linha de rótulo com selos diferentes ("Classificação: Falso" numa fala,
 * "Classificação: Exagerado" em outra) é matéria com várias falas, não selo único ⇒ null.
 * O mesmo selo repetido (no topo e no fim da página) vale.
 */
export function ratingFromLabel(text: string): string | null {
  const re = /^(?:classifica[cç][aã]o|etiqueta|selo|veredito|avalia[cç][aã]o)\s*:\s*(.{3,40})$/gim;
  const labels = [...text.matchAll(re)].map((m) => m[1]!.trim());
  if (new Set(labels.map(normalizeRating)).size > 1) return null;
  return labels.find((l) => RATING_TABLE[normalizeRating(l)]) ?? null;
}
