// Mocks offline: banco em memória (com o índice único e o trigger de evidência),
// cliente Anthropic falso, Voyage/Tavily falsos e relógio.
import type {
  Alert, ChunkMatch, Debate, DebateSettings, FactcheckMatch, IndicatorMatch, IndicatorSeries, IndicatorValue,
  KbWebFindInsert, RefElection, RefMandate, Segment, VerifiedClaimMatch,
} from "@actually/db";
import { EMBEDDING_DIM } from "@actually/db";
import type { PipelineDeps, AnthropicLike } from "../src/deps";
import type { EmbedFn } from "../src/embed";
import { normalizeText } from "../src/normalize";
import type { RerankFn } from "../src/rerank";
import type { WebSearchFn } from "../src/retrieve/web";
import {
  DbError, PG_CHECK_VIOLATION, PG_UNIQUE_VIOLATION, type NewAlert, type NewClaim, type NewEvidence,
  type NewVerification, type PipelineStore,
} from "../src/store";
import type { ExtractionOutput } from "../src/extract";
import type { VerifyOutput } from "../src/verify";

export const DEBATE_ID = "00000000-0000-4000-8000-000000000001";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Promessa que nunca resolve (simula serviço travado; o timeout tem que agir). */
export const hang = <T>() => new Promise<T>(() => {});

// ---------------------------------------------------------------------------
// Embeddings determinísticos: saco de palavras com hash → 1024 dims, normalizado
// ---------------------------------------------------------------------------
export function fakeVector(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const w of normalizeText(text).split(" ")) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[Math.abs(h) % EMBEDDING_DIM]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
export const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

// ---------------------------------------------------------------------------
// Banco em memória
// ---------------------------------------------------------------------------
type Row<T> = T & { id: string; created_at: string };

export interface KbFixture {
  factchecks?: FactcheckMatch[];
  chunks?: ChunkMatch[];
  series?: IndicatorSeries[];
  values?: IndicatorValue[];
  mandates?: RefMandate[];
  elections?: RefElection[];
}

export interface DelayFixture {
  /** ms por método (simula latência de rede). */
  [method: string]: number | undefined;
}

export class MemoryStore implements PipelineStore {
  segments: Segment[] = [];
  debate: Debate;
  claims: Row<NewClaim>[] = [];
  verifications: Row<NewVerification>[] = [];
  evidence: Row<NewEvidence>[] = [];
  alerts: Row<NewAlert & { published_at: string | null }>[] = [];
  /** Fila kb_web_finds (url única: repetida é ignorada). */
  webFinds: KbWebFindInsert[] = [];
  /** Métodos chamados, em ordem (para conferir o que foi gravado antes de quê). */
  calls: string[] = [];
  private seq = 0;
  /** Métodos que devem falhar (simula banco/RPC fora). */
  failing = new Set<string>();
  /** Mapa de falantes confirmado (getSpeakerMap). */
  speakerMap: { speaker_label: string; person: string }[] = [];
  /** Antes do insertClaim: hook para simular corrida. */
  beforeInsertClaim: ((row: NewClaim) => void) | null = null;

  constructor(public kb: KbFixture = {}, settings: Partial<DebateSettings> = {}, public delays: DelayFixture = {}) {
    this.debate = {
      id: DEBATE_ID, slug: "teste", title: "Debate teste", youtube_url: null, status: "live",
      settings, created_at: "2026-10-23T22:00:00Z", started_at: null, ended_at: null, scheduled_at: null, is_test: false,
      public_note: null, check_mode: null,
    };
  }

  private nextId(prefix: string) {
    this.seq++;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }
  private async gate(method: string) {
    this.calls.push(method);
    const d = this.delays[method];
    if (d) await sleep(d);
    if (this.failing.has(method)) throw new DbError(`${method}: falha simulada`, "XX000");
  }

  addSegment(text: string, over: Partial<Segment> = {}): Segment {
    const id = this.segments.length + 1;
    const seg: Segment = {
      id, debate_id: DEBATE_ID, agent_id: "agent-1", seq: id, speaker_label: "SPEAKER_1", text,
      t_start: id * 10, t_end: id * 10 + 8, captured_at: new Date(Date.UTC(2026, 9, 23, 22, 0, id * 10)).toISOString(),
      received_at: new Date().toISOString(), ...over,
    };
    this.segments.push(seg);
    return seg;
  }

  async getSegment(id: number) {
    await this.gate("getSegment");
    const segment = this.segments.find((s) => s.id === id);
    return segment ? { segment, debate: this.debate } : null;
  }
  async getSpeakerMap(_debateId: string) {
    await this.gate("getSpeakerMap");
    return this.speakerMap;
  }
  async getContext(debateId: string, capturedAt: string, windowS: number, excludeId: number) {
    await this.gate("getContext");
    const to = Date.parse(capturedAt);
    return this.segments.filter((s) => s.debate_id === debateId && s.id !== excludeId &&
      Date.parse(s.captured_at) < to && Date.parse(s.captured_at) >= to - windowS * 1000);
  }
  async findClaimByHash(debateId: string, hash: string) {
    await this.gate("findClaimByHash");
    const c = this.claims.find((x) => x.debate_id === debateId && x.claim_hash === hash && !x.duplicate_of);
    if (!c) return null;
    const v = [...this.verifications].reverse().find((x) => x.claim_id === c.id);
    const a = v ? this.alerts.find((x) => x.verification_id === v.id && !x.is_repeat) : undefined;
    const attempts = this.claims.filter((x) => x.debate_id === debateId && x.claim_hash === hash).map((x) => x.created_at).sort();
    return {
      claim_id: c.id, verification_id: v?.id ?? null, verdict: v?.verdict ?? null,
      alert_id: a?.id ?? null, alert_status: a?.status ?? null, verified_at: v?.created_at ?? null,
      last_attempt_at: attempts.at(-1) ?? null,
    };
  }
  async matchVerifiedClaims(debateId: string, embedding: number[], minSimilarity: number, count: number): Promise<VerifiedClaimMatch[]> {
    await this.gate("matchVerifiedClaims");
    const out: VerifiedClaimMatch[] = [];
    for (const c of this.claims) {
      if (c.duplicate_of || !c.embedding) continue;
      const v = [...this.verifications].reverse().find((x) => x.claim_id === c.id);
      if (!v) continue;
      const a = this.alerts.find((x) => x.verification_id === v.id && !x.is_repeat);
      const sim = cosine(c.embedding, embedding);
      if (sim < minSimilarity) continue;
      if (!(c.debate_id === debateId || a?.status === "published" || v.verdict === "confirmado")) continue;
      out.push({
        claim_id: c.id, debate_id: c.debate_id, text_normalized: c.text_normalized, numbers: c.numbers,
        indicator: c.indicator, verification_id: v.id, verdict: v.verdict, alert_id: a?.id ?? null,
        alert_status: a?.status ?? null, verified_at: v.created_at, similarity: sim,
      });
    }
    return out.sort((x, y) => y.similarity - x.similarity).slice(0, count);
  }
  async getAlert(id: string) {
    await this.gate("getAlert");
    return (this.alerts.find((a) => a.id === id) as unknown as Alert | undefined) ?? null;
  }
  async insertClaim(row: NewClaim) {
    this.beforeInsertClaim?.(row);
    await this.gate("insertClaim");
    // índice único parcial claims_unique_hash (debate_id, claim_hash) where duplicate_of is null
    if (!row.duplicate_of && this.claims.some((c) => c.debate_id === row.debate_id && c.claim_hash === row.claim_hash && !c.duplicate_of)) {
      throw new DbError('duplicate key value violates unique constraint "claims_unique_hash"', PG_UNIQUE_VIOLATION);
    }
    const id = this.nextId("claim");
    this.claims.push({ ...row, id, created_at: new Date().toISOString() });
    return { id };
  }
  async insertVerification(row: NewVerification) {
    await this.gate("insertVerification");
    const id = this.nextId("ver");
    const created_at = new Date().toISOString();
    this.verifications.push({ ...row, id, created_at });
    return { id, created_at };
  }
  async insertEvidence(rows: NewEvidence[]) {
    await this.gate("insertEvidence");
    for (const r of rows) {
      if (!/^https?:\/\//i.test(r.url) || !r.quote.trim()) throw new DbError("evidence check", PG_CHECK_VIOLATION);
      this.evidence.push({ ...r, id: this.nextId("ev"), created_at: new Date().toISOString() });
    }
  }
  async insertAlert(row: NewAlert) {
    await this.gate("insertAlert");
    // trigger alerts_require_evidence
    if (row.status === "published" && !this.evidence.some((e) => e.verification_id === row.verification_id && e.quote_verified && /^https?:\/\//.test(e.url) && e.quote.trim())) {
      throw new DbError("alerta não pode ser publicado sem evidência com URL e trecho verificado", PG_CHECK_VIOLATION);
    }
    const id = this.nextId("alert");
    this.alerts.push({ ...row, id, created_at: new Date().toISOString(), published_at: row.status === "published" ? new Date().toISOString() : null });
    return { id };
  }
  async matchFactchecks() {
    await this.gate("matchFactchecks");
    return this.kb.factchecks ?? [];
  }
  async matchChunks() {
    await this.gate("matchChunks");
    return this.kb.chunks ?? [];
  }
  async findIndicator(q: string): Promise<IndicatorMatch[]> {
    await this.gate("findIndicator");
    const nq = normalizeText(q);
    return (this.kb.series ?? [])
      .filter((s) => [s.name, ...s.aliases].some((n) => nq.includes(normalizeText(n)) || normalizeText(n).includes(nq)))
      .map((s) => ({ code: s.code, name: s.name, unit: s.unit, periodicity: s.periodicity, aggregation: s.aggregation, source_name: s.source_name, source_url: s.source_url, tier: s.tier, score: 0.9 }));
  }
  async indicatorValues(code: string) {
    await this.gate("indicatorValues");
    return (this.kb.values ?? []).filter((v) => v.series_code === code);
  }
  async refMandates() {
    await this.gate("refMandates");
    return this.kb.mandates ?? [];
  }
  async refElections(year: number, round: number) {
    await this.gate("refElections");
    return (this.kb.elections ?? []).filter((e) => e.ano === year && e.turno === round);
  }
  async saveWebFinds(rows: KbWebFindInsert[]) {
    await this.gate("saveWebFinds");
    // upsert on conflict (url) do nothing: conta só as inseridas
    const fresh = rows.filter((r) => !this.webFinds.some((w) => w.url === r.url));
    this.webFinds.push(...fresh);
    return fresh.length;
  }

}

// ---------------------------------------------------------------------------
// Anthropic falso: responde conforme o modelo pedido, usando o parser real do
// zodOutputFormat (valida o schema como em produção)
// ---------------------------------------------------------------------------
export type FakeReply<T> =
  | { output: T; delayMs?: number }
  | { refusal: true; delayMs?: number }
  | { error: Error; delayMs?: number }
  | { hang: true };

export interface FakeAnthropicScript {
  extract: (userText: string) => FakeReply<ExtractionOutput>;
  verify: (userText: string) => FakeReply<VerifyOutput>;
}

export interface FakeAnthropic extends AnthropicLike {
  calls: { model: string; user: string }[];
}

export function fakeAnthropic(script: FakeAnthropicScript): FakeAnthropic {
  const calls: { model: string; user: string }[] = [];
  const parse = async (params: any) => {
    const user = String(params.messages[0].content);
    calls.push({ model: params.model, user });
    const reply = params.model.includes("haiku") ? script.extract(user) : script.verify(user);
    if ("hang" in reply) return hang();
    if (reply.delayMs) await sleep(reply.delayMs);
    if ("error" in reply) throw reply.error;
    const base = { id: "msg_fake", type: "message", role: "assistant", model: params.model, stop_sequence: null, stop_details: null, usage: {} };
    if ("refusal" in reply) {
      return { ...base, stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null }, content: [], parsed_output: null };
    }
    const text = JSON.stringify(reply.output);
    const parsed = params.output_config.format.parse(text);
    return { ...base, stop_reason: "end_turn", content: [{ type: "text", text }], parsed_output: parsed };
  };
  return { messages: { parse } as unknown as AnthropicLike["messages"], calls } as FakeAnthropic;
}

// ---------------------------------------------------------------------------
// Voyage / Tavily falsos
// ---------------------------------------------------------------------------
export function fakeEmbed(opts: { delayMs?: number; fail?: boolean; hang?: boolean } = {}): EmbedFn & { calls: number } {
  const fn = (async (texts: string[]) => {
    fn.calls++;
    if (opts.hang) return hang();
    if (opts.delayMs) await sleep(opts.delayMs);
    if (opts.fail) throw new Error("voyage embeddings 503");
    return texts.map(fakeVector);
  }) as unknown as EmbedFn & { calls: number };
  fn.calls = 0;
  return fn;
}

/** Rerank falso: todo documento com relevância fixa (0,9 por padrão). */
export function fakeRerank(opts: { delayMs?: number; fail?: boolean; score?: number } = {}): RerankFn {
  return async (_q, docs, topK) => {
    if (opts.delayMs) await sleep(opts.delayMs);
    if (opts.fail) throw new Error("voyage rerank 500");
    return docs.map((_, index) => ({ index, relevance_score: opts.score ?? 0.9 })).slice(0, topK);
  };
}

export function fakeWeb(results: Awaited<ReturnType<WebSearchFn>> = [], opts: { fail?: boolean; hang?: boolean; delayMs?: number } = {}): WebSearchFn & { calls: number } {
  const fn = (async () => {
    fn.calls++;
    if (opts.hang) return hang();
    if (opts.delayMs) await sleep(opts.delayMs);
    if (opts.fail) throw new Error("tavily 502");
    return results;
  }) as unknown as WebSearchFn & { calls: number };
  fn.calls = 0;
  return fn;
}

export interface LogLine {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

export function makeDeps(over: Partial<PipelineDeps> & { store: PipelineStore; anthropic: AnthropicLike }): PipelineDeps & { logs: LogLine[] } {
  const logs: LogLine[] = [];
  return {
    embed: fakeEmbed(),
    rerank: fakeRerank(),
    webSearch: null,
    logger: (level, event, fields) => logs.push({ level, event, fields }),
    now: Date.now,
    ...over,
    logs,
  };
}

// ---------------------------------------------------------------------------
// Fixtures de base de conhecimento
// ---------------------------------------------------------------------------
export const PNAD: IndicatorSeries = {
  code: "desocupacao_pnadc", name: "Taxa de desocupação", aliases: ["desemprego", "desocupação"], unit: "%",
  periodicity: "quarterly", aggregation: "mean_or_last", source_name: "IBGE", source_url: "https://sidra.ibge.gov.br/tabela/4099", tier: 1, notes: null,
};
const quarter = (y: number, qq: number, value: number): IndicatorValue => {
  const m0 = (qq - 1) * 3 + 1;
  return {
    series_code: PNAD.code, period_start: `${y}-${String(m0).padStart(2, "0")}-01`,
    period_end: new Date(Date.UTC(y, m0 + 2, 0)).toISOString().slice(0, 10), value, released_at: null,
  };
};
/** 2023: 8,0 8,0 7,6 7,6 → média 7,8; último 7,6. */
export const PNAD_VALUES = [quarter(2023, 1, 8.0), quarter(2023, 2, 8.0), quarter(2023, 3, 7.6), quarter(2023, 4, 7.6)];

export const DOC_TEXT = "O programa Mais Médicos foi criado pela Lei 12.871, sancionada em 22 de outubro de 2013, durante o governo Dilma Rousseff.";
export const DOC_CHUNK: ChunkMatch = {
  chunk_id: 1, document_id: "doc-1", url: "https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/lei/l12871.htm",
  title: "Lei 12.871/2013", doc_type: "lei", person: null, source_name: "Planalto (legislação)", tier: 1,
  published_at: "2013-10-22T00:00:00Z", text: DOC_TEXT, similarity: 0.85, rrf_score: 0.03,
};

export const FACTCHECK: FactcheckMatch = {
  id: "fc-1", source_name: "Aos Fatos", url: "https://www.aosfatos.org/noticias/bolsa-familia-beneficiarios/",
  claim_text: "O Bolsa Família atende 30 milhões de famílias", rating_original: "Exagerado", verdict: "impreciso",
  person: null, quote: "Em setembro de 2026, o Bolsa Família pagou benefícios a 20,8 milhões de famílias, segundo o MDS.",
  body: null, published_at: "2026-10-01T00:00:00Z", similarity: 0.9, rrf_score: 0.03,
};
