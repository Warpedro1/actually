// Tipos e formatação do painel "Uso das APIs" do /admin (cliente e servidor).
import type { ApiUsageWindow } from "@actually/db";

export type UsageStatus = "ok" | "sem_chave" | "sem_permissao" | "erro" | "formato" | "sem_api";

export interface UsageLine {
  label: string;
  text: string;
  /** Para a barra de progresso, quando o provedor informa um limite. */
  used?: number;
  limit?: number;
}

export interface CountedWindow {
  janela: ApiUsageWindow;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  units: number;
  cost_usd: number;
}

export type UsageCardId = "anthropic" | "voyage" | "tavily" | "google_factcheck" | "apify" | "deepgram" | "supabase" | "vercel";

export interface UsageCard {
  id: UsageCardId;
  name: string;
  link: string;
  status: UsageStatus;
  message?: string;
  /** Dados oficiais do provedor (vazio se ele não informa). */
  official: UsageLine[];
  /** Contado pelo actually, por janela (somando modelos). */
  counted: CountedWindow[];
  ratelimit: { headers: Record<string, string>; observed_at: string } | null;
}

export interface UsageReport {
  generated_at: string;
  cards: UsageCard[];
  counted_error: string | null;
}

export const STATUS_PILL: Record<UsageStatus, { text: string; tone: "neutral" | "ok" | "warn" | "bad" }> = {
  ok: { text: "ok", tone: "ok" },
  sem_chave: { text: "sem chave", tone: "warn" },
  sem_permissao: { text: "sem permissão", tone: "bad" },
  erro: { text: "erro", tone: "bad" },
  formato: { text: "formato inesperado", tone: "warn" },
  sem_api: { text: "sem API de uso", tone: "neutral" },
};

export const WINDOW_LABEL: Record<ApiUsageWindow, string> = { hora: "Esta hora", hoje: "Hoje", "24h": "24 h", mes: "Mês" };

/** Fração usada (0–1) e o tom da barra; null se não há limite. */
export function usageFraction(line: Pick<UsageLine, "used" | "limit">): { frac: number; tone: "ok" | "warn" | "bad" } | null {
  if (line.used === undefined || line.limit === undefined || !(line.limit > 0)) return null;
  const frac = Math.min(1, Math.max(0, line.used / line.limit));
  return { frac, tone: frac >= 0.9 ? "bad" : frac >= 0.7 ? "warn" : "ok" };
}

const compact = (v: number) => v.toLocaleString("pt-BR", { notation: v >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });

/** Resumo de uma janela contada, só com o que é relevante para o provedor (cada parte não quebra no meio). */
export function countedParts(id: UsageCardId, w: CountedWindow): string[] {
  const parts: string[] = [];
  if (id === "tavily") parts.push(`${compact(w.units)} créditos`);
  else if (id === "apify") parts.push(`${compact(w.units || w.requests)} execuções`);
  else parts.push(`${compact(w.requests)} chamadas`);
  if (w.input_tokens || w.output_tokens) {
    parts.push(w.output_tokens ? `${compact(w.input_tokens)} tokens entrada` : `${compact(w.input_tokens)} tokens`);
    if (w.output_tokens) parts.push(`${compact(w.output_tokens)} saída`);
  }
  if (w.cost_usd > 0) parts.push(`≈ US$ ${w.cost_usd.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: w.cost_usd < 1 ? 4 : 2 })}`);
  return parts;
}

export const countedText = (id: UsageCardId, w: CountedWindow): string => countedParts(id, w).join(" · ");

/** Cabeçalhos de limite mais úteis primeiro (restante antes de limite e reset). */
export function ratelimitEntries(headers: Record<string, string>): [string, string][] {
  const rank = (k: string) => (k.includes("remaining") ? 0 : k.includes("limit") && !k.includes("reset") ? 1 : k.includes("reset") ? 2 : 3);
  return Object.entries(headers).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}
