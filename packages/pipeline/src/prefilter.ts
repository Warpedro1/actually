// Pré-filtro barato, antes de gastar LLM. Conservador: só descarta o que com
// certeza não tem fato checável; na dúvida, deixa passar para a extração.
import { normalizeText } from "./normalize";

export interface PrefilterResult {
  pass: boolean;
  reason: string | null;
}

/** Falas de moderação/cortesia que não carregam fato. Comparadas sobre o texto normalizado. */
const NON_FACTUAL_PATTERNS: RegExp[] = [
  /^(boa noite|bom dia|boa tarde|ola|oi)\b/,
  /^(muito )?obrigad[oa]\b/,
  /^(tempo|seu tempo|o tempo) (esgotado|encerrado|acabou)\b/,
  /^(candidat[oa]|senhor[a]?|presidente|senador[a]?)\b.{0,40}\b(tem|com) (a palavra|direito de resposta|\d+ (segundos|minutos))\b/,
  /^(vamos|passamos) (ao|para o|a|para a) (proximo|proxima|segundo|terceiro|quarto|ultimo|bloco|pergunta|intervalo)/,
  /^(pergunta|resposta|replica|treplica|direito de resposta)\b/,
  /^(voltamos|estamos de volta|ate ja|ate logo|fique com a gente)\b/,
];

/** Palavras que, sozinhas, não formam afirmação (cortesia, interjeição, chamamento). */
const FILLER = new Set([
  "boa", "noite", "bom", "dia", "tarde", "obrigado", "obrigada", "muito", "candidato", "candidata",
  "senhor", "senhora", "presidente", "sim", "nao", "claro", "olha", "veja", "bem", "entao", "ne", "ok",
  "pois", "e", "o", "a", "os", "as", "de", "do", "da", "que", "eu", "voce", "aqui", "agora", "ai",
  "certo", "exatamente", "perfeito", "isso", "ta", "tudo", "pessoal", "gente", "brasileiros", "brasileiras",
  "povo", "brasileiro", "todos", "todas", "voces", "telespectador", "telespectadores", "mediador", "mediadora", "tempo", "palavra",
]);

export function prefilter(text: string): PrefilterResult {
  const norm = normalizeText(text);
  if (!norm) return { pass: false, reason: "vazio" };
  const words = norm.split(" ");
  const hasDigit = /\d/.test(norm);

  if (words.length < 3 && !hasDigit) return { pass: false, reason: "curto" };
  if (!hasDigit && words.every((w) => FILLER.has(w))) return { pass: false, reason: "so_cortesia" };

  // moderação/cortesia curta (falas longas podem conter fato depois do cumprimento)
  if (!hasDigit && words.length <= 15 && NON_FACTUAL_PATTERNS.some((re) => re.test(norm))) {
    return { pass: false, reason: "moderacao" };
  }

  // só perguntas: toda frase termina em "?" e não há número
  const sentences = text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  if (!hasDigit && sentences.length > 0 && sentences.every((s) => s.endsWith("?"))) {
    return { pass: false, reason: "so_pergunta" };
  }

  return { pass: true, reason: null };
}
