// Contrato público do pipeline. A implementação vive nos módulos irmãos
// (prefilter, extract, dedup, retrieve/*, verify, quoteCheck, score, publish).
import { resolveSettings, type DebateSettings, type KbLayer, type Segment, type SourceTier } from "@actually/db";
import { MODEL_VERIFY, TIMEOUTS_MS } from "./config";
import { dedupAndRecord } from "./dedup";
import { defaultDeps, type PipelineDeps } from "./deps";
import { extractClaims } from "./extract";
import { errorFields, withTimeout } from "./log";
import { claimHash } from "./normalize";
import { isOnlyQuestions, prefilter } from "./prefilter";
import { publishVerification } from "./publish";
import { numbersSupported, quoteCheck } from "./quoteCheck";
import { measureQueryOf, retrieveAll } from "./retrieve/index";
import { scoreDecision, type ScoreResult } from "./score";
import type { EvidenceCandidate, EvidenceRecord, ExtractedClaim, ModelVerdict, RetrievalResult } from "./types";
import { inconclusive, verifyClaim } from "./verify";
import { queueWebFinds, type WebFound } from "./webFinds";

export interface PipelineResult {
  segment_id: number;
  claims: number;
  /** Alertas criados (published + pending_review), incluindo repetições. */
  alerts: number;
  /**
   * Páginas da web (L4) que entraram na fila kb_web_finds neste trecho — gravadas depois
   * dos alertas; 0 se nada novo, chave `learnFromWeb` desligada ou falha. > 0 ⇒ vale
   * disparar a carga que as transforma em base (preset "capturas-web").
   */
  web_finds: number;
  latency_ms: Record<string, number>;
}

export type AlertLevel = "red" | "yellow";

/** Resultado de checar uma afirmação sem gravar nada (usado pelo eval e por testes). */
export interface ClaimDecision {
  /** Afirmação atômica, já com contexto resolvido. */
  claim: string;
  /** Tipo da fala (fato, estatística, acusação, opinião mensurável, previsão). */
  kind: import("./types").ClaimKind;
  /** O alerta passa pelo editor mesmo com HITL desligado (ex.: acusação). */
  review: boolean;
  verdict: import("@actually/db").Verdict;
  final_score: number;
  /** null = silêncio (abaixo do threshold, regra dura ou não checável). */
  alert: AlertLevel | null;
  /** Por que ficou em silêncio, quando ficou. */
  silence_reason: string | null;
  layer: import("@actually/db").KbLayer | null;
  correction: string | null;
  evidence: {
    url: string;
    source_name: string;
    source_tier: import("@actually/db").SourceTier;
    quote: string;
    quote_verified: boolean;
  }[];
  latency_ms: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Núcleo comum a runPipeline e evaluateText
// ---------------------------------------------------------------------------

/** Avaliação de uma afirmação (sem escrita). */
export interface Assessment {
  decision: ClaimDecision;
  model: ModelVerdict;
  score: ScoreResult | null;
  evidence: EvidenceRecord[];
  retrieval: RetrievalResult;
  /** O modelo deu um veredito de fato (vale gravar `verifications`). */
  verify_ran: boolean;
  /** Números da correção/resumo sem fonte (auditoria). */
  unsupported_numbers?: string[];
  latency_ms: Record<string, number>;
}

/** Pessoa do mapa de falantes que é a mediação do debate (não é candidato). */
const MEDIATOR_RE = /^(mediacao|mediador|mediadora|moderacao|moderador|moderadora|jornalista|apresentador|apresentadora)\b/;
const isMediatorPerson = (person: string) => MEDIATOR_RE.test(person.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase());

const today = (deps: PipelineDeps) => new Date(deps.now()).toISOString().slice(0, 10);

/** "2026-10-18T..." → "18/10/2026" (como a correção costuma escrever a data); ilegível ⇒ null. */
function brDate(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

/** Transcrição anterior com quem falou: a pessoa do mapa quando houver ("[Lula] ..."), senão o rótulo. */
function formatContext(
  segments: Pick<Segment, "speaker_label" | "text">[],
  people: Map<string, string> = new Map(),
): string {
  return segments
    .map((s) => `[${(s.speaker_label && people.get(s.speaker_label)) ?? s.speaker_label ?? "?"}] ${s.text}`)
    .join("\n");
}

/**
 * Converte as citações do modelo em evidências, conferindo cada trecho contra a fonte.
 * `verifiedTexts`: só os trechos verificados (citação casada + frase em volta, ou o
 * texto do L2 gerado em código) — é contra eles que os números da correção são conferidos.
 */
export function buildEvidence(
  model: ModelVerdict,
  candidates: EvidenceCandidate[],
  retrieval: Pick<RetrievalResult, "comparison">,
): { records: EvidenceRecord[]; total: number; verified: number; verifiedTexts: string[] } {
  const byIndex = new Map<number, EvidenceRecord>();
  const verifiedTexts: string[] = [];
  let verified = 0;
  for (const c of model.citations) {
    const cand = candidates[c.evidence_index];
    if (!cand) continue;
    let rec: EvidenceRecord;
    if (cand.layer === "L2" && cand.comparison) {
      // evidência determinística: a citação é o texto gerado em código
      rec = toRecord(cand, cand.text, true, 1);
      verifiedTexts.push(cand.text);
    } else {
      const qc = quoteCheck(c.quote, cand.text);
      // verificada ⇒ grava o texto LITERAL da fonte (o trecho casado), nunca o do modelo;
      // não verificada ⇒ guarda o que o modelo disse, só para auditoria (não vai a público)
      rec = qc.verified && qc.matched
        ? toRecord(cand, qc.matched, true, qc.similarity)
        : toRecord(cand, c.quote.trim(), false, qc.similarity);
      if (rec.quote_verified && qc.context) verifiedTexts.push(qc.context);
    }
    if (rec.quote_verified) verified++;
    const prev = byIndex.get(c.evidence_index);
    // uma linha por fonte: fica a melhor citação
    if (!prev || (!prev.quote_verified && rec.quote_verified) || (prev.quote_verified === rec.quote_verified && rec.quote_similarity > prev.quote_similarity)) {
      byIndex.set(c.evidence_index, rec);
    }
  }
  // indicador comparado em código entra sempre (mesmo sem citação do modelo)
  const l2Index = candidates.findIndex((c) => c.layer === "L2" && c.comparison && c.comparison.status !== "no_data");
  if (l2Index >= 0 && !byIndex.has(l2Index) && retrieval.comparison?.expected_verdict) {
    const cand = candidates[l2Index]!;
    byIndex.set(l2Index, toRecord(cand, cand.text, true, 1));
    verifiedTexts.push(cand.text);
  }
  const records = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  return { records, total: model.citations.length, verified, verifiedTexts };
}

function toRecord(c: EvidenceCandidate, quote: string, verified: boolean, similarity: number): EvidenceRecord {
  return {
    layer: c.layer, evidence_type: c.evidence_type, url: c.url, source_name: c.source_name,
    source_tier: c.source_tier, quote, quote_verified: verified, published_at: c.published_at,
    quote_similarity: similarity, ...(c.factcheck_verdict ? { factcheck_verdict: c.factcheck_verdict } : {}),
    ...(c.weak ? { weak: true } : {}),
  };
}

function silentDecision(claim: ExtractedClaim, reason: string, latency: Record<string, number>, layer: KbLayer | null = null): ClaimDecision {
  return {
    claim: claim.text_normalized, kind: claim.kind, review: false, verdict: "inconclusivo", final_score: 0, alert: null,
    silence_reason: reason, layer, correction: null, evidence: [], latency_ms: latency,
  };
}

export async function assessClaim(
  deps: PipelineDeps,
  claim: ExtractedClaim,
  embedding: number[] | null,
  context: string,
  settings: DebateSettings,
  /** Texto inteiro do segmento (fala literal); padrão: o trecho da afirmação. */
  segmentText: string = claim.text_original,
  /** Falas anteriores do MESMO falante (sem rótulo): o que ele disse antes também vale como número negado. */
  sameSpeakerContext = "",
): Promise<Assessment> {
  const latency: Record<string, number> = {};
  let t = deps.now();
  const retrieval = await retrieveAll(deps, claim, embedding);
  latency.retrieve = deps.now() - t;
  for (const l of retrieval.layers) latency[`retrieve_${l.layer}`] = l.latency_ms;

  const candidates = retrieval.candidates;
  if (!candidates.length) {
    return {
      decision: silentDecision(claim, "sem_evidencia", latency), model: inconclusive("sem_evidencia"),
      score: null, evidence: [], retrieval, verify_ran: false, latency_ms: latency,
    };
  }

  t = deps.now();
  const model = await withTimeout(
    verifyClaim(deps.anthropic, {
      claim_normalized: claim.text_normalized, claim_original: claim.text_original,
      kind: claim.kind, measurable: claim.measurable,
      context, today: today(deps), evidence: candidates,
    }, deps.logger, deps.usage),
    TIMEOUTS_MS.verify_total,
    "verify",
  ).catch((err) => {
    deps.logger("warn", "verify_timeout", errorFields(err));
    return inconclusive("timeout_verificacao");
  });
  latency.verify = deps.now() - t;

  t = deps.now();
  const ev = buildEvidence(model, candidates, retrieval);
  // números da fala não sustentam a correção; só valem negados ("…, não 12%"), e só se o
  // falante os disse: ano ou número sem unidade vem da fala literal dele (a reformulação pode
  // ter inventado o "2003"; o contexto tem a mediação e o adversário — e o rótulo do falante,
  // "[s1-4f9a12:S0]", que viraria número); com unidade, a reformulação também vale
  // ("7 e meio por 100" → 7,5%)
  const said = { refuted: [claim.text_original, segmentText, sameSpeakerContext], refutedWithUnit: [claim.text_normalized] };
  // a data de publicação de uma fonte verificada e a data da fala também valem na correção
  // ("segundo a Lupa, em 18/10/2026, ...") — estão no cabeçalho da evidência, não no trecho
  const dates = [today(deps), ...ev.records.filter((r) => r.quote_verified && r.published_at).map((r) => r.published_at!)]
    .map(brDate)
    .filter((d): d is string => d !== null);
  const numberSources = [...ev.verifiedTexts, ...dates];
  const numsCorrection = numbersSupported(model.correction, numberSources, said);
  const numsSummary = numbersSupported(model.summary, numberSources, said);
  const nums = {
    ok: numsCorrection.ok && numsSummary.ok,
    unsupported: [...numsCorrection.unsupported, ...numsSummary.unsupported],
  };
  latency.quote_check = deps.now() - t;

  const score = scoreDecision({
    verdict: model.verdict,
    model_confidence: model.confidence,
    evidence: ev.records,
    citations_total: ev.total,
    citations_verified: ev.verified,
    comparison: retrieval.comparison,
    forced_reason: model.forced_reason,
    correction: model.correction,
    correction_numbers_ok: nums.ok,
    kind: claim.kind,
    settings,
  });
  if (!nums.ok) deps.logger("warn", "correction_number_unsupported", { unsupported: nums.unsupported });

  const decision: ClaimDecision = {
    claim: claim.text_normalized,
    kind: claim.kind,
    review: score.review,
    verdict: model.verdict,
    final_score: score.final_score,
    alert: score.alert,
    silence_reason: score.silence_reason,
    layer: score.layer ?? candidates[0]?.layer ?? null,
    correction: model.correction || null,
    evidence: ev.records.map((e) => ({
      url: e.url, source_name: e.source_name, source_tier: e.source_tier as SourceTier,
      quote: e.quote, quote_verified: e.quote_verified,
    })),
    latency_ms: latency,
  };
  // refusal também é gravado (auditoria); erros/timeouts não — a afirmação pode ser tentada de novo
  const verify_ran = model.forced_reason === null || model.forced_reason === "refusal";
  return { decision, model, score, evidence: ev.records, retrieval, verify_ran, latency_ms: latency, unsupported_numbers: nums.unsupported };
}

async function embedClaims(deps: PipelineDeps, claims: ExtractedClaim[]): Promise<(number[] | null)[]> {
  if (!claims.length) return [];
  try {
    const vecs = await withTimeout(deps.embed(claims.map((c) => c.text_normalized), "query"), TIMEOUTS_MS.embed, "embed");
    return claims.map((_, i) => vecs[i] ?? null);
  } catch (err) {
    // sem embedding: segue só com hash, L2 e L4
    deps.logger("warn", "embed_failed", errorFields(err));
    return claims.map(() => null);
  }
}

async function safeExtract(
  deps: PipelineDeps,
  text: string,
  context: string,
  speaker: string | null,
  people: { person: string | null; opponents: string[] } = { person: null, opponents: [] },
): Promise<ExtractedClaim[]> {
  try {
    return await withTimeout(
      extractClaims(
        deps.anthropic,
        {
          text,
          context,
          speaker_label: speaker,
          speaker_person: people.person,
          opponents: people.opponents,
          today: today(deps),
        },
        deps.logger,
        deps.usage,
      ),
      TIMEOUTS_MS.extract + 1_000,
      "extract",
    );
  } catch (err) {
    deps.logger("warn", "extract_failed", errorFields(err));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fábrica com dependências injetadas
// ---------------------------------------------------------------------------
export function createPipeline(deps: PipelineDeps) {
  const { logger, store } = deps;

  /** Fim da fala (captured_at) → agora. */
  const sinceSpeech = (segment: Segment) => deps.now() - Date.parse(segment.captured_at);

  async function processClaim(
    claim: ExtractedClaim,
    embedding: number[] | null,
    segment: Segment,
    context: string,
    settings: DebateSettings,
    /** Etapas do segmento (filter, context, extract, embed), compartilhadas pelas afirmações dele. */
    segmentLatency: Record<string, number>,
    /** Onde juntar o que a web trouxe (a base aprende com a web); null = não guarda. */
    webFound: WebFound[] | null,
    /** Falas anteriores do mesmo falante, sem rótulo (números negados na correção). */
    sameSpeakerContext = "",
  ): Promise<number> {
    const t0 = deps.now();
    const hash = claimHash(claim.text_normalized);
    const dedup = await dedupAndRecord(deps, {
      debate_id: segment.debate_id, segment, claim, hash, embedding, settings,
    });
    const tDedup = deps.now() - t0;
    if (dedup.kind === "duplicate") {
      // repetição não grava verificação: a latência (até o alerta de repetição gravado) fica no log
      logger("info", "claim_duplicate_latency", {
        segment_id: segment.id, claim_id: dedup.claim_id, repeat_alert_id: dedup.repeat_alert?.id ?? null,
        latency_ms: { ...segmentLatency, dedup: tDedup, e2e: sinceSpeech(segment) },
      });
      return dedup.repeat_alert ? 1 : 0;
    }

    const a = await assessClaim(deps, claim, embedding, context, settings, segment.text, sameSpeakerContext);
    // a página vale para a base qualquer que seja a decisão (gravada no fim do trecho)
    if (webFound && a.retrieval.web_found) webFound.push({ query: measureQueryOf(claim), found: a.retrieval.web_found });
    const latency: Record<string, number> = { ...segmentLatency, dedup: tDedup, ...a.latency_ms };
    if (!a.verify_ran) {
      logger("info", "claim_silence", {
        segment_id: segment.id, claim_id: dedup.claim_id, reason: a.decision.silence_reason, latency_ms: latency,
      });
      return 0;
    }

    const tPub = deps.now();
    // verifications é append-only e é gravada antes de evidence/alerts: o que vai para
    // verifications.latency_ms é o que já se sabe aqui. O e2e de verdade (fim da fala →
    // alerta gravado) só existe depois do publish — fica no log e em alerts.created_at.
    latency.e2e_pre_publish = sinceSpeech(segment);
    const persisted = { ...latency };
    const layer: KbLayer = a.decision.layer ?? "L1";
    const res = await withTimeout(publishVerification(store, {
      debate_id: segment.debate_id,
      claim_id: dedup.claim_id,
      // nova tentativa: a verificação fica na original, para as próximas repetições a reaproveitarem
      verification_claim_id: dedup.retry_of,
      claim_text: claim.text_normalized,
      speaker_label: segment.speaker_label,
      segment_t_end: segment.t_end,
      verdict: a.model.verdict,
      correction: a.model.correction,
      summary: a.model.summary,
      model_confidence: a.model.confidence,
      final_score: a.decision.final_score,
      score_components: {
        ...(a.score?.components ?? {}),
        ...(a.decision.silence_reason ? { silence_reason: a.decision.silence_reason } : {}),
        // auditoria (verificação sem alerta não é pública): de onde veio o tipo e o que travou
        ...(claim.kind_model ? { kind_model: claim.kind_model } : {}),
        ...(claim.kind_rule ? { kind_rule: claim.kind_rule } : {}),
        ...(a.unsupported_numbers?.length ? { unsupported_numbers: a.unsupported_numbers.join("|").slice(0, 200) } : {}),
        ...(a.decision.alert ? {} : a.model.summary ? { summary_silenced: a.model.summary.slice(0, 280) } : {}),
      },
      layer,
      model: MODEL_VERIFY,
      latency_ms: persisted,
      evidence: a.evidence,
      alert: a.decision.alert,
      force_review: a.decision.review,
      settings,
    }, logger), TIMEOUTS_MS.publish, "publish");
    latency.publish = deps.now() - tPub;
    latency.e2e = sinceSpeech(segment);

    logger("info", "claim_decision", {
      segment_id: segment.id, claim_id: dedup.claim_id, retry_of: dedup.retry_of ?? null, verification_id: res.verification_id,
      verdict: a.decision.verdict, final_score: a.decision.final_score, alert: a.decision.alert,
      alert_status: res.alert_status, silence_reason: a.decision.silence_reason, layer, latency_ms: latency,
    });
    return res.alert_id ? 1 : 0;
  }

  /**
   * Processa um segmento já gravado em `segments`: filtra, extrai afirmações,
   * aplica a trava de repetição, recupera evidências (L1–L4), verifica, pontua
   * e grava claims/verifications/evidence/alerts. Nunca lança por falha de
   * uma afirmação isolada — registra e segue (silêncio é o modo seguro).
   * Com `learnFromWeb`, depois dos alertas espera a busca web e põe as páginas na
   * fila kb_web_finds (`web_finds` no resultado).
   */
  async function runPipeline(segmentId: number): Promise<PipelineResult> {
    try {
      return await runSegment(segmentId);
    } finally {
      await flushUsage();
    }
  }

  /**
   * Grava o uso das APIs acumulado (painel do /admin). Roda depois do trecho —
   * os alertas já foram gravados — e falha só vira log (RNF03).
   */
  async function flushUsage(): Promise<void> {
    if (!deps.usage || !store.recordUsage) return;
    const { rows, ratelimits } = deps.usage.drain();
    if (!rows.length && !Object.keys(ratelimits).length) return;
    try {
      await withTimeout(store.recordUsage(rows, ratelimits), TIMEOUTS_MS.usage, "usage");
    } catch (err) {
      logger("warn", "usage_record_failed", errorFields(err));
    }
  }

  /**
   * Mapa de falantes confirmado pelo editor (rótulo → pessoa). Falha ao ler ⇒ vazio: segue
   * como debate sem mapa (a regra do prompt continua valendo e as travas de pessoa não agem).
   */
  async function speakerMap(debateId: string): Promise<Map<string, string>> {
    if (!store.getSpeakerMap) return new Map();
    try {
      const rows = await withTimeout(store.getSpeakerMap(debateId), TIMEOUTS_MS.context, "speaker_map");
      return new Map(rows.map((r) => [r.speaker_label, r.person]));
    } catch (err) {
      logger("warn", "speaker_map_failed", errorFields(err));
      return new Map();
    }
  }

  /**
   * Situação do rótulo neste mapa: "mediacao", "mapeado" (candidato, Outro), "sem_mapa" (o
   * debate já tem mapa, este rótulo não) ou "debate_sem_mapa".
   */
  function speakerStatus(people: Map<string, string>, label: string): "mediacao" | "mapeado" | "sem_mapa" | "debate_sem_mapa" {
    if (!people.size) return "debate_sem_mapa";
    const person = people.get(label);
    if (person === undefined) return "sem_mapa";
    return isMediatorPerson(person) ? "mediacao" : "mapeado";
  }

  async function runSegment(segmentId: number): Promise<PipelineResult> {
    const t0 = deps.now();
    const latency: Record<string, number> = {};
    const result = (claims: number, alerts: number, web_finds = 0): PipelineResult =>
      ({ segment_id: segmentId, claims, alerts, web_finds, latency_ms: latency });

    const loaded = await store.getSegment(segmentId);
    if (!loaded) {
      logger("error", "segment_not_found", { segment_id: segmentId });
      return result(0, 0);
    }
    const { segment, debate } = loaded;
    const settings = resolveSettings(debate.settings);

    let t = deps.now();
    const pf = prefilter(segment.text);
    latency.filter = deps.now() - t;
    if (!pf.pass) {
      logger("debug", "segment_prefiltered", { segment_id: segmentId, reason: pf.reason });
      return result(0, 0);
    }

    const people = await speakerMap(segment.debate_id);
    if (segment.speaker_label) {
      const speaker = speakerStatus(people, segment.speaker_label);
      // fala de quem o editor mapeou como Mediação não é checada (pergunta, regra, dado citado)
      if (speaker === "mediacao") {
        logger("info", "extract_dropped", { segment_id: segmentId, reason: "mediacao", speaker_label: segment.speaker_label });
        return result(0, 0);
      }
      // voz que o editor ainda não mapeou (jornalista, sessão nova da captura) só perguntando:
      // sem número o pré-filtro já descarta; com número ("desde o 1º turno ... não é?") ia ao
      // extrator, que pode virar a pergunta em afirmação (ensaio de 18/10, jornalista sem mapa)
      if (speaker === "sem_mapa" && isOnlyQuestions(segment.text)) {
        logger("info", "unmapped_question_skipped", { segment_id: segmentId, speaker_label: segment.speaker_label });
        return result(0, 0);
      }
    }
    // quem fala e o adversário (as outras pessoas do mapa que não são a mediação): o extrator
    // resolve "você"/"ele" com isso e a trava de sujeito trocado confere (ensaio da Band)
    const person = (segment.speaker_label && people.get(segment.speaker_label)) || null;
    const opponents = person
      ? [...new Set([...people.values()].filter((p) => p !== person && !isMediatorPerson(p)))]
      : [];

    t = deps.now();
    const ctxSegments = await withTimeout(
      store.getContext(segment.debate_id, segment.captured_at, settings.context_window_s, segment.id),
      TIMEOUTS_MS.context,
      "context",
    ).catch((err) => {
      logger("warn", "context_failed", { segment_id: segmentId, ...errorFields(err) });
      return [] as Segment[];
    });
    const context = formatContext(ctxSegments, people);
    const sameSpeakerContext = segment.speaker_label
      ? ctxSegments.filter((s) => s.speaker_label === segment.speaker_label).map((s) => s.text).join("\n")
      : "";
    latency.context = deps.now() - t;

    t = deps.now();
    const claims = await safeExtract(deps, segment.text, context, segment.speaker_label, { person, opponents });
    latency.extract = deps.now() - t;
    if (!claims.length) {
      latency.e2e = sinceSpeech(segment);
      logger("info", "segment_done", { segment_id: segmentId, claims: 0, alerts: 0, latency_ms: latency });
      return result(0, 0);
    }

    t = deps.now();
    const embeddings = await embedClaims(deps, claims);
    latency.embed = deps.now() - t;

    const segmentLatency = { filter: latency.filter!, context: latency.context!, extract: latency.extract!, embed: latency.embed! };
    // sem a chave, nada é guardado nem esperado (base forte continua não esperando a web)
    const webFound: WebFound[] | null = deps.learnFromWeb && store.saveWebFinds ? [] : null;
    t = deps.now();
    const alerts = await Promise.all(
      claims.map((c, i) =>
        processClaim(c, embeddings[i] ?? null, segment, context, settings, segmentLatency, webFound, sameSpeakerContext).catch((err) => {
          logger("error", "claim_failed", { segment_id: segmentId, claim: c.text_normalized, ...errorFields(err) });
          return 0;
        }),
      ),
    );
    latency.claims = deps.now() - t;
    latency.total = deps.now() - t0;
    latency.e2e = sinceSpeech(segment);
    const n = alerts.reduce((s, x) => s + x, 0);
    logger("info", "segment_done", { segment_id: segmentId, claims: claims.length, alerts: n, latency_ms: latency });
    // só agora, com os alertas do trecho já gravados: a espera pela web não atrasa nenhum
    const webFinds = webFound ? await queueWebFinds(deps, segment, webFound) : 0;
    return result(claims.length, n, webFinds);
  }

  /**
   * Modo seco: roda filtro → extração → retrieval → verificação → score sobre um
   * texto, lendo a base de conhecimento mas sem escrever nada. Sem trava de
   * repetição (não há debate). `context` é a transcrição anterior (até ~60 s).
   */
  async function evaluateText(
    text: string,
    context: string,
    opts?: { settings?: Partial<DebateSettings> },
  ): Promise<ClaimDecision[]> {
    const settings = resolveSettings(opts?.settings);
    const t0 = deps.now();
    if (!prefilter(text).pass) return [];
    const claims = await safeExtract(deps, text, context, null);
    const tExtract = deps.now() - t0;
    if (!claims.length) return [];
    const tE = deps.now();
    const embeddings = await embedClaims(deps, claims);
    const tEmbed = deps.now() - tE;
    return Promise.all(
      claims.map(async (c, i) => {
        try {
          const a = await assessClaim(deps, c, embeddings[i] ?? null, context, settings, text);
          return { ...a.decision, latency_ms: { extract: tExtract, embed: tEmbed, ...a.decision.latency_ms, total: deps.now() - t0 } };
        } catch (err) {
          logger("error", "evaluate_claim_failed", { claim: c.text_normalized, ...errorFields(err) });
          return silentDecision(c, "erro", { extract: tExtract, embed: tEmbed });
        }
      }),
    );
  }

  return { runPipeline, evaluateText };
}

export type Pipeline = ReturnType<typeof createPipeline>;

let pipeline: Pipeline | null = null;
const live = (): Pipeline => (pipeline ??= createPipeline(defaultDeps()));

/** Ver `createPipeline().runPipeline`. Usa as dependências reais do env. */
export async function runPipeline(segmentId: number): Promise<PipelineResult> {
  return live().runPipeline(segmentId);
}

/** Ver `createPipeline().evaluateText`. Usa as dependências reais do env. */
export async function evaluateText(
  text: string,
  context: string,
  opts?: { settings?: Partial<import("@actually/db").DebateSettings> },
): Promise<ClaimDecision[]> {
  return live().evaluateText(text, context, opts);
}

export type { PipelineDeps } from "./deps";
export { defaultDeps } from "./deps";
