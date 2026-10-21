// A base aprende com a web: as páginas que a busca web (L4) trouxe durante a checagem
// vão para a fila kb_web_finds; a carga (kb-ingest, etapa "capturas-web") as transforma
// em checagem (L1) ou documento (L3). Roda depois dos alertas do trecho e nunca lança:
// falha ou lentidão só viram log (RNF03).
import type { KbWebFindInsert } from "@actually/db";
import { TIMEOUTS_MS, WEB_FIND_MAX_CHARS, WEB_FIND_MIN_CHARS } from "./config";
import type { PipelineDeps } from "./deps";
import { errorFields, withTimeout } from "./log";
import type { EvidenceCandidate } from "./types";

/** O que a L4 trouxe para uma afirmação do trecho. */
export interface WebFound {
  /** A busca usada (a afirmação normalizada ou o dado que a mede). */
  query: string;
  /** RetrievalResult.web_found (nunca rejeita). */
  found: Promise<EvidenceCandidate[]>;
}

/** Corta sem partir um par substituto (emoji etc.): metade dele derruba a inserção inteira. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** Data que o banco aceita (timestamptz) ou null: data ilegível do buscador não derruba o lote. */
function isoDate(s: string | null): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Linhas da fila: só página L4 de nível 1–2, http(s), com o texto inteiro (pelo menos
 * WEB_FIND_MIN_CHARS — o trecho curto do buscador fica de fora), uma por URL (fica a
 * primeira busca que a trouxe), texto cortado em WEB_FIND_MAX_CHARS.
 */
export function webFindRows(
  found: { query: string; candidates: EvidenceCandidate[] }[],
  debateId: string,
): KbWebFindInsert[] {
  const seen = new Set<string>();
  const rows: KbWebFindInsert[] = [];
  for (const { query, candidates } of found) {
    for (const c of candidates) {
      if (c.layer !== "L4" || c.source_tier > 2 || !/^https?:\/\//i.test(c.url) || seen.has(c.url)) continue;
      // \u0000 não cabe em text no Postgres (derrubaria a inserção do trecho inteiro)
      const text = c.text.replace(/\u0000/g, "").trim();
      if (text.length < WEB_FIND_MIN_CHARS) continue;
      seen.add(c.url);
      rows.push({
        url: c.url, title: c.title ?? "", text: cut(text, WEB_FIND_MAX_CHARS), source_name: c.source_name,
        tier: c.source_tier as 1 | 2, published_at: isoDate(c.published_at), query, debate_id: debateId,
      });
    }
  }
  return rows;
}

/**
 * Espera o que a web trouxe para as afirmações do trecho e grava na fila. Devolve quantas
 * páginas entraram (0 se nada, sem `store.saveWebFinds` ou falha). Nunca lança.
 */
export async function queueWebFinds(
  deps: PipelineDeps,
  segment: { id: number; debate_id: string },
  pending: WebFound[],
): Promise<number> {
  const { logger, store } = deps;
  if (!pending.length || !store.saveWebFinds) return 0;
  try {
    // a L4 começou antes e tem timeout próprio: esta espera nunca passa do prazo dela
    const found = await withTimeout(
      Promise.all(pending.map(async (p) => ({
        query: p.query,
        candidates: await p.found.catch((): EvidenceCandidate[] => []),
      }))),
      TIMEOUTS_MS.L4,
      "web_finds_wait",
    );
    const rows = webFindRows(found, segment.debate_id);
    if (!rows.length) return 0;
    const n = await withTimeout(store.saveWebFinds(rows), TIMEOUTS_MS.web_finds, "web_finds");
    logger("info", "web_finds_saved", { segment_id: segment.id, n, pages: rows.length });
    return n;
  } catch (err) {
    logger("warn", "web_finds_failed", { segment_id: segment.id, ...errorFields(err) });
    return 0;
  }
}
