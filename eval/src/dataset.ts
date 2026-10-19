// Formato do conjunto rotulado (eval/data/*.jsonl) e do cache de decisões
// (eval/results/<timestamp>/decisions.jsonl). Ver eval/README.md.
import { z } from "zod";
import type { ClaimDecision } from "@actually/pipeline";

export const VERDICTS = ["contradito", "impreciso", "confirmado", "inconclusivo"] as const;
export type AlertLevel = "red" | "yellow";

export const Expected = z
  .object({
    /** A fala contém uma afirmação factual checável? */
    checkable: z.boolean(),
    /** Veredito de referência (null quando não checável). */
    verdict: z.enum(VERDICTS).nullable(),
    /** O que o sistema DEVERIA mostrar ao público. */
    alert: z.enum(["red", "yellow"]).nullable(),
  })
  .superRefine((e, ctx) => {
    if (!e.checkable && (e.verdict !== null || e.alert !== null)) {
      ctx.addIssue({ code: "custom", message: "não checável ⇒ verdict e alert devem ser null" });
    }
    if (e.checkable && e.verdict === null) {
      ctx.addIssue({ code: "custom", message: "checável ⇒ verdict obrigatório" });
    }
    if (e.alert === "red" && e.verdict !== "contradito") {
      ctx.addIssue({ code: "custom", message: 'alert "red" exige verdict "contradito"' });
    }
    if (e.alert === "yellow" && e.verdict !== "impreciso" && e.verdict !== "contradito") {
      ctx.addIssue({ code: "custom", message: 'alert "yellow" exige verdict "impreciso" ou "contradito"' });
    }
    if ((e.verdict === "confirmado" || e.verdict === "inconclusivo") && e.alert !== null) {
      ctx.addIssue({ code: "custom", message: "confirmado/inconclusivo ⇒ alert null" });
    }
  });
export type Expected = z.infer<typeof Expected>;

export const EvalItem = z.object({
  id: z.string().min(1),
  /** De onde veio a fala, ex.: "debate-2026-10-18", "debate-2022-band", "sintetico". */
  source: z.string().min(1),
  /** Rótulo de quem falou: nome do candidato, "mediador", ou "A"/"B" nos sintéticos. */
  speaker: z.string().min(1),
  /** Segundos desde o início da gravação de origem (0 nos sintéticos). */
  t: z.number().nonnegative(),
  /** Transcrição anterior (~60 s) — o que a extração recebe como contexto. */
  context: z.string(),
  /** A fala avaliada (um segmento, como o capture agent entregaria). */
  text: z.string().min(1),
  /** Tópico-guia (economia, seguranca, ...). Opcional; usado nos recortes. */
  topic: z.string().min(1).optional(),
  expected: Expected,
  /** Fontes que sustentam o rótulo. Obrigatórias quando checkable=true e não sintético. */
  reference_urls: z.array(z.string().url()),
  notes: z.string(),
  synthetic: z.boolean(),
});
export type EvalItem = z.infer<typeof EvalItem>;

export interface ParseIssue {
  line: number;
  message: string;
}

/** Lê um JSONL do conjunto rotulado. Erros de linha são devolvidos, não lançados. */
export function parseDataset(raw: string): { items: EvalItem[]; issues: ParseIssue[] } {
  const items: EvalItem[] = [];
  const issues: ParseIssue[] = [];
  const seen = new Set<string>();
  raw.split(/\r?\n/).forEach((lineText, i) => {
    const line = i + 1;
    const trimmed = lineText.trim();
    if (!trimmed || trimmed.startsWith("//")) return;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (e) {
      issues.push({ line, message: `JSON inválido: ${(e as Error).message}` });
      return;
    }
    const parsed = EvalItem.safeParse(json);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((iss) => `${iss.path.join(".") || "(item)"}: ${iss.message}`).join("; ");
      issues.push({ line, message: msg });
      return;
    }
    const item = parsed.data;
    if (seen.has(item.id)) {
      issues.push({ line, message: `id duplicado: ${item.id}` });
      return;
    }
    if (item.expected.checkable && !item.synthetic && item.reference_urls.length === 0) {
      issues.push({ line, message: `${item.id}: item real checável sem reference_urls` });
      return;
    }
    seen.add(item.id);
    items.push(item);
  });
  return { items, issues };
}

/** Uma linha de decisions.jsonl: o item rotulado + a saída crua do pipeline. */
export interface DecisionRecord {
  item_id: string;
  source: string;
  speaker: string;
  topic: string | null;
  text: string;
  expected: Expected;
  synthetic: boolean;
  reference_urls: string[];
  /** Tempo de parede de evaluateText para o item (ms). */
  wall_ms: number;
  /** Mensagem de erro se evaluateText lançou — o item conta como silêncio. */
  error: string | null;
  decisions: ClaimDecision[];
}

export function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

export function parseDecisions(raw: string): DecisionRecord[] {
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DecisionRecord);
}
