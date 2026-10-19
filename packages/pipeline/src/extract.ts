// Filtro + extração numa única chamada Haiku (latência): devolve as
// afirmações checáveis atômicas da fala atual, com contexto resolvido.
import type { IndicatorRef } from "@actually/db";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL_EXTRACT, TIMEOUTS_MS } from "./config";
import type { AnthropicLike } from "./deps";
import type { Logger } from "./log";
import { normalizeClaimNumbers } from "./normalize";
import { normalizeForQuote, quoteCheck } from "./quoteCheck";
import { TOPICS, type ExtractedClaim, type Topic } from "./types";

// Schema leniente de propósito: enums viram texto e são validados em código,
// para que um campo secundário fora do padrão não derrube a extração inteira.
export const ExtractionSchema = z.object({
  claims: z.array(
    z.object({
      text_original: z.string().describe("Trecho literal da fala atual que contém a afirmação."),
      text_normalized: z.string().describe("Afirmação autossuficiente em PT-BR, com sujeito e tempo resolvidos."),
      topic: z.string().describe(`Um de: ${TOPICS.join(", ")}`),
      numbers: z.array(
        z.object({
          value: z.number().describe("Valor numérico absoluto (\"1,5 milhão\" → 1500000; \"6%\" → 6)."),
          unit: z.string().nullable().describe("\"%\", \"p.p.\", \"R$\", \"km2\" ou null."),
          raw: z.string().describe("Como foi dito, ex.: \"quase 10 milhões\"."),
        }),
      ),
      indicator: z
        .object({
          query: z.string().describe("Nome do indicador como dito (ex.: \"desemprego\", \"inflação\")."),
          period: z.string().nullable().describe("AAAA | AAAA-T1..T4 | AAAA-MM | intervalo INICIO..FIM; null se 'hoje/atual'."),
          claimed_value: z.number().nullable(),
          unit: z.string().nullable(),
          kind: z.string().describe("level | change_abs | change_pct | max | min"),
        })
        .nullable(),
      time_reference: z.string().nullable().describe("Referência temporal resolvida, ex.: \"2023\", \"2019 a 2022\"."),
    }),
  ),
});
export type ExtractionOutput = z.infer<typeof ExtractionSchema>;

const INDICATOR_KINDS: IndicatorRef["kind"][] = ["level", "change_abs", "change_pct", "max", "min"];

// Prompt de sistema estável (sem data nem nada variável) — bom para cache.
export const EXTRACT_SYSTEM = `Você é o extrator de afirmações checáveis de um sistema de checagem de fatos AO VIVO do debate presidencial brasileiro de 2026 (Lula x Flávio Bolsonaro). Precisão vale mais que cobertura: na dúvida, NÃO extraia.

Você recebe a transcrição automática dos últimos segundos (<contexto>) e a fala atual (<fala_atual>). Extraia SOMENTE afirmações da fala atual que sejam fatos verificáveis contra dados públicos: números, estatísticas, datas, atos de governo, leis, votações, declarações passadas, resultados de políticas.

NÃO extraia:
- opiniões e juízos de valor ("o melhor governo da história", "a economia vai mal");
- promessas, planos e previsões ("vou criar 10 milhões de empregos");
- hipóteses e condicionais; perguntas; ataques sem fato concreto ("ele é mentiroso");
- cumprimentos, falas do mediador, regras do debate, fatos sobre o próprio debate;
- afirmações cujo sujeito, objeto ou período não dá para resolver com segurança pelo contexto.

Para cada afirmação:
- text_original: trecho LITERAL da fala atual (copie exatamente como transcrito).
- text_normalized: frase autossuficiente em português, com sujeito e tempo explícitos. Resolva "isso", "ele", "lá", "no meu governo", "no governo dele", "ano passado" usando o contexto e a data do debate. Se o falante não puder ser identificado com segurança, NÃO atribua o governo a ninguém — descarte a afirmação se ela depender disso.
- Uma afirmação = um fato. Separe frases com dois fatos em duas afirmações.
- topic: economia, impostos, programas_sociais, seguranca, corrupcao_justica, saude, meio_ambiente, educacao, politica_externa ou outro.
- numbers: todos os números da afirmação, com valor absoluto ("1,5 milhão" → 1500000; "R$ 600" → 600 com unidade "R$"; "6%" → 6 com unidade "%").
- indicator: preencha só quando a afirmação é sobre o valor de um indicador oficial (desemprego/desocupação, inflação/IPCA, Selic, PIB, dívida pública, salário mínimo, desmatamento, homicídios, preço de combustível, beneficiários de programa social...). period: "AAAA", "AAAA-T4", "AAAA-MM" ou intervalo "INICIO..FIM" (ex.: "2019..2022"); null quando a fala diz "hoje"/"atualmente". kind: level (valor no período), change_abs (variação absoluta; em indicador percentual, pontos percentuais), change_pct (variação relativa %), max/min (recorde). claimed_value: o número afirmado; use negativo só se a fala disser queda explicitamente em uma variação.
- time_reference: período resolvido em texto, ou null.

Se não houver nada checável, devolva {"claims": []}.

Exemplos (resumidos):
Fala: "Boa noite a todos, é uma honra estar aqui." → {"claims": []}
Fala: "Eu vou acabar com a fome em dois anos." → {"claims": []}
Fala: "No meu governo o desemprego caiu para 6,6%." (contexto indica o presidente Lula, falando de 2024) → text_normalized "A taxa de desemprego no Brasil foi de 6,6% em 2024, durante o governo Lula."; indicator {query "desemprego", period "2024", claimed_value 6.6, unit "%", kind "level"}.
Fala: "O desmatamento na Amazônia caiu quase 50% de 2022 para 2023." → indicator {query "desmatamento Amazônia", period "2022..2023", claimed_value 50, unit "%", kind "change_pct"}; numbers [{value 50, unit "%", raw "quase 50%"}].
Fala: "Ele votou contra a PEC da Transição." (contexto: o senador Flávio Bolsonaro) → text_normalized "O senador Flávio Bolsonaro votou contra a PEC da Transição."; indicator null.`;

function toTopic(t: string): Topic {
  const n = t.trim().toLowerCase();
  return (TOPICS as readonly string[]).includes(n) ? (n as Topic) : "outro";
}

function toIndicator(raw: ExtractionOutput["claims"][number]["indicator"]): IndicatorRef | null {
  if (!raw || !raw.query.trim()) return null;
  const kind = raw.kind.trim() as IndicatorRef["kind"];
  if (!INDICATOR_KINDS.includes(kind)) return null;
  return {
    query: raw.query.trim(),
    period: raw.period?.trim() || null,
    claimed_value: raw.claimed_value ?? null,
    unit: raw.unit?.trim() || null,
    kind,
  };
}

/** Pós-processamento determinístico: valida, normaliza números e descarta o que não está na fala. */
export function postprocessExtraction(out: ExtractionOutput, segmentText: string, logger: Logger): ExtractedClaim[] {
  const segNorm = normalizeForQuote(segmentText);
  const claims: ExtractedClaim[] = [];
  for (const c of out.claims) {
    const original = c.text_original.trim();
    const normalized = c.text_normalized.trim();
    if (!original || !normalized) continue;
    // o trecho precisa estar na fala atual (o modelo não pode inventar afirmação)
    const inSegment = segNorm.includes(normalizeForQuote(original)) || quoteCheck(original, segmentText).verified;
    if (!inSegment) {
      logger("warn", "extract_claim_not_in_segment", { text_original: original });
      continue;
    }
    claims.push({
      text_original: original,
      text_normalized: normalized,
      topic: toTopic(c.topic),
      numbers: normalizeClaimNumbers(c.numbers),
      indicator: toIndicator(c.indicator),
      time_reference: c.time_reference?.trim() || null,
    });
  }
  return claims;
}

export interface ExtractInput {
  text: string;
  /** Transcrição anterior (janela de contexto). */
  context: string;
  speaker_label?: string | null;
  /** YYYY-MM-DD — "hoje" para resolver referências temporais. */
  today: string;
}

/** Monta a mensagem do usuário (a parte variável fica fora do system). */
export function buildExtractMessage(input: ExtractInput): string {
  const speaker = input.speaker_label ? ` locutor="${input.speaker_label}"` : "";
  return [
    `Data da fala: ${input.today}. Contexto: debate eleitoral presidencial de 2026.`,
    `<contexto>\n${input.context.trim() || "(sem contexto)"}\n</contexto>`,
    `<fala_atual${speaker}>\n${input.text.trim()}\n</fala_atual>`,
    "Extraia as afirmações checáveis da fala atual.",
  ].join("\n\n");
}

/**
 * Chama o Haiku com saída estruturada. Qualquer falha (refusal, corte por
 * max_tokens, JSON inválido) vira lista vazia — silêncio.
 */
export async function extractClaims(
  client: AnthropicLike,
  input: ExtractInput,
  logger: Logger,
): Promise<ExtractedClaim[]> {
  const msg = await client.messages.parse(
    {
      model: MODEL_EXTRACT,
      max_tokens: 2_000,
      // extração é mecânica: sem raciocínio estendido, esforço baixo (latência)
      thinking: { type: "disabled" },
      system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildExtractMessage(input) }],
      output_config: { effort: "low", format: zodOutputFormat(ExtractionSchema) },
    },
    { timeout: TIMEOUTS_MS.extract, maxRetries: 0 },
  );
  if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") {
    logger("warn", "extract_incomplete", { stop_reason: msg.stop_reason });
    return [];
  }
  if (!msg.parsed_output) {
    logger("warn", "extract_unparsed", { stop_reason: msg.stop_reason });
    return [];
  }
  return postprocessExtraction(msg.parsed_output, input.text, logger);
}
