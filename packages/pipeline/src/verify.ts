// Verificação (Sonnet, saída estruturada): julga a afirmação SÓ com as
// evidências fornecidas. Refusal, corte, timeout ou JSON inválido viram
// "inconclusivo" — silêncio.
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { EVIDENCE_CHARS_FOR_VERIFY, MAX_EVIDENCE_FOR_VERIFY, MODEL_VERIFY, SUMMARY_MAX_CHARS, TIMEOUTS_MS } from "./config";
import type { AnthropicLike } from "./deps";
import { errorFields, type Logger } from "./log";
import type { ClaimKind, EvidenceCandidate, ModelVerdict } from "./types";
import { anthropicUsageRow, type UsageMeter } from "./usage";

export const VerifySchema = z.object({
  rationale: z.string().describe("Raciocínio curto (até 3 frases) ligando a afirmação às evidências."),
  verdict: z.enum(["contradito", "impreciso", "confirmado", "inconclusivo"]),
  confidence: z.number().describe("0 a 1: quão certo o veredito é, dadas SÓ as evidências."),
  correction: z.string().describe("1 linha em PT-BR com o dado correto e a fonte; vazio se confirmado/inconclusivo."),
  summary: z.string().describe("Resumo para o alerta, até 140 caracteres."),
  citations: z.array(
    z.object({
      evidence_index: z.number().int().describe("Número da evidência, como [1]."),
      quote: z.string().describe("Trecho COPIADO LITERALMENTE do texto da evidência."),
    }),
  ),
});
export type VerifyOutput = z.infer<typeof VerifySchema>;

export const VERIFY_SYSTEM = `Você é o verificador de um sistema de checagem de fatos AO VIVO do debate presidencial brasileiro de 2026. Cada alerta errado prejudica o público e os candidatos: precisão vale mais que cobertura.

Regras:
1. Julgue a afirmação SOMENTE com as evidências numeradas fornecidas. Nunca use conhecimento próprio para contradizer ou confirmar; se as evidências não bastam, o veredito é "inconclusivo".
2. Vereditos:
   - "contradito": as evidências mostram diretamente que a afirmação é falsa.
   - "impreciso": a essência procede, mas um número, data ou detalhe relevante está errado ou exagerado além de arredondamento razoável, ou falta contexto que muda o sentido.
   - "confirmado": as evidências sustentam a afirmação.
   - "inconclusivo": evidências insuficientes, indiretas, sobre outro assunto/pessoa/período, ou contraditórias entre si.
3. Tempo importa: se a evidência é de outro período que o da afirmação (ex.: dado de 2022 para uma fala sobre "hoje"), use "impreciso" só se a própria evidência mostrar a divergência; caso contrário, "inconclusivo".
4. Arredondamentos e aproximações comuns de fala ("quase 10 milhões", "cerca de 6%") não tornam a afirmação imprecisa.
5. Citações: para cada evidência usada, copie em "quote" um trecho LITERAL e contíguo do texto da evidência (sem parafrasear, sem juntar partes, sem corrigir erros) que sustente o veredito. Use o número da evidência em "evidence_index". Sem citação literal, não há alerta.
6. "correction": uma linha em português com o dado correto, apenas com números que aparecem nas evidências (ex.: "Segundo o IBGE, a taxa de desocupação em 2023 foi de 7,8%."). Vazio se "confirmado" ou "inconclusivo".
7. "summary": até 140 caracteres, neutro, sem adjetivos, sem nomear o candidato.
8. "confidence": calibrada — 0,9+ só quando a evidência é direta, oficial e sobre exatamente o mesmo fato e período.
9. Tipo "opinião mensurável": julgue se os dados que medem o ponto indicado em "O que medir" contradizem a fala de forma clara. Exagero retórico com fundo verdadeiro não é impreciso. Sem dado direto sobre exatamente isso, "inconclusivo". Nunca "contradito": use "impreciso" quando os dados mostram o contrário.
10. Tipo "previsão": compare com as projeções publicadas nas evidências (Banco Central/Focus, IFI, Tesouro, FMI, agências de rating...). "impreciso" só se a fala diverge claramente de todas as projeções citadas; projeções divergentes entre si ou ausentes, "inconclusivo". Nunca "contradito". A correção diz quem projetou e quando.
11. Tipo "acusação": julgue só fatos processuais — denunciado, réu, condenado, absolvido, anulado, arquivado, prescrito, investigado, indiciado, inelegível — com órgão e data. Nunca julgue culpa nem intenção. Anulação não é absolvição; investigação não é condenação. A correção cita o órgão e a data da decisão.`;

function evidenceBlock(c: EvidenceCandidate, i: number): string {
  const kind = { L1: "checagem publicada", L2: "indicador oficial (série)", L3: "documento", L4: "página web" }[c.layer];
  const header = [
    `[${i + 1}] Fonte: ${c.source_name} (tier ${c.source_tier}, ${kind})`,
    c.published_at ? `Data: ${c.published_at.slice(0, 10)}` : null,
    `URL: ${c.url}`,
    c.title ? `Título: ${c.title}` : null,
  ].filter(Boolean).join(" · ");
  const text = c.text.length > EVIDENCE_CHARS_FOR_VERIFY ? `${c.text.slice(0, EVIDENCE_CHARS_FOR_VERIFY)}…` : c.text;
  return `${header}\nTexto:\n"""\n${text}\n"""`;
}

export interface VerifyInput {
  claim_normalized: string;
  claim_original: string;
  kind?: ClaimKind;
  /** Opinião/previsão: o dado ou a projeção que mede a fala. */
  measurable?: string | null;
  context: string;
  today: string;
  evidence: EvidenceCandidate[];
}

const KIND_LABEL: Record<ClaimKind, string> = {
  fato: "fato",
  estatistica: "estatística",
  acusacao: "acusação (regra 11)",
  opiniao_mensuravel: "opinião mensurável (regra 9)",
  previsao: "previsão (regra 10)",
};

export function buildVerifyMessage(input: VerifyInput): string {
  return [
    `Data da fala: ${input.today}. Contexto: debate eleitoral presidencial de 2026.`,
    `Afirmação a verificar: "${input.claim_normalized}"`,
    `Trecho original da fala: "${input.claim_original}"`,
    input.kind && input.kind !== "fato" && input.kind !== "estatistica" ? `Tipo da fala: ${KIND_LABEL[input.kind]}` : null,
    input.measurable ? `O que medir: ${input.measurable}` : null,
    input.context.trim() ? `<contexto>\n${input.context.trim()}\n</contexto>` : null,
    `Evidências:\n\n${input.evidence.map(evidenceBlock).join("\n\n")}`,
  ].filter(Boolean).join("\n\n");
}

export function inconclusive(reason: string): ModelVerdict {
  return { verdict: "inconclusivo", confidence: 0, correction: "", summary: "", citations: [], forced_reason: reason };
}

/** Normaliza a saída: confiança em [0,1], resumo ≤ 140, citações com índice 0-based válido. */
export function sanitizeVerdict(out: VerifyOutput, evidenceCount: number): ModelVerdict {
  const conf = Number.isFinite(out.confidence) ? Math.min(1, Math.max(0, out.confidence)) : 0;
  let summary = out.summary.trim().replace(/\s+/g, " ");
  if (summary.length > SUMMARY_MAX_CHARS) summary = `${summary.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  return {
    verdict: out.verdict,
    confidence: conf,
    correction: out.correction.trim().replace(/\s+/g, " "),
    summary,
    citations: out.citations
      .map((c) => ({ evidence_index: c.evidence_index - 1, quote: c.quote }))
      .filter((c) => Number.isInteger(c.evidence_index) && c.evidence_index >= 0 && c.evidence_index < evidenceCount && c.quote.trim()),
    forced_reason: null,
  };
}

export async function verifyClaim(
  client: AnthropicLike,
  input: VerifyInput,
  logger: Logger,
  usage?: UsageMeter,
): Promise<ModelVerdict> {
  const evidence = input.evidence.slice(0, MAX_EVIDENCE_FOR_VERIFY);
  if (!evidence.length) return inconclusive("sem_evidencia");
  try {
    const msg = await client.messages.parse(
      {
        model: MODEL_VERIFY,
        max_tokens: 8_000,
        system: [{ type: "text", text: VERIFY_SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildVerifyMessage({ ...input, evidence }) }],
        output_config: { effort: "low", format: zodOutputFormat(VerifySchema) },
      },
      { timeout: TIMEOUTS_MS.verify, maxRetries: 1 },
    );
    usage?.record(anthropicUsageRow(MODEL_VERIFY, msg.usage));
    if (msg.stop_reason === "refusal") {
      logger("warn", "verify_refusal", { stop_details: msg.stop_details ?? null });
      return inconclusive("refusal");
    }
    if (msg.stop_reason === "max_tokens") return inconclusive("max_tokens");
    if (!msg.parsed_output) return inconclusive("sem_saida_estruturada");
    return sanitizeVerdict(msg.parsed_output, evidence.length);
  } catch (err) {
    logger("warn", "verify_failed", errorFields(err));
    return inconclusive("erro_verificacao");
  }
}
