// Score final + regras duras. FUNÇÃO PURA: tudo que decide se um alerta sai
// está aqui, testável sem rede. Na dúvida, silêncio.
import type { DebateSettings, KbLayer, SourceTier, Verdict } from "@actually/db";
import { KIND_RULES } from "./config";
import type { AlertLevel } from "./index";
import type { ClaimKind, EvidenceRecord, IndicatorComparison } from "./types";

export const TIER_WEIGHT: Record<SourceTier, number> = { 1: 1, 2: 0.85, 3: 0.6, 4: 0.2 };
export const SCORE_WEIGHTS = { confidence: 0.5, tier: 0.2, agreement: 0.2, quotes: 0.1 } as const;

export interface ScoreInput {
  verdict: Verdict;
  model_confidence: number;
  /** Evidências citadas (já com quote_verified) + a evidência determinística do L2. */
  evidence: EvidenceRecord[];
  /** Citações devolvidas pelo modelo e quantas passaram na checagem. */
  citations_total: number;
  citations_verified: number;
  /** Comparação L2, se houve indicador. */
  comparison: IndicatorComparison | null;
  /** Inconclusivo forçado (refusal, parse, timeout...). */
  forced_reason: string | null;
  correction: string;
  /** Números da correção/resumo existem nas fontes verificadas. */
  correction_numbers_ok: boolean;
  /** Tipo da fala (regras em KIND_RULES). Ausente = "fato". */
  kind?: ClaimKind;
  settings: Pick<DebateSettings, "t_red" | "t_yellow" | "web_penalty">;
}

export interface ScoreResult {
  final_score: number;
  alert: AlertLevel | null;
  silence_reason: string | null;
  layer: KbLayer | null;
  components: Record<string, number | string | boolean>;
  /** O alerta passa pelo editor mesmo com HITL desligado (ex.: acusação). */
  review: boolean;
}

const LAYER_PREF: Record<KbLayer, number> = { L2: 0, L1: 1, L3: 2, L4: 3 };
const isAlertVerdict = (v: Verdict) => v === "contradito" || v === "impreciso";

/** Melhor evidência: menor tier, depois camada preferida (L2 > L1 > L3 > L4). */
function bestEvidence(list: EvidenceRecord[]): EvidenceRecord | null {
  return [...list].sort((a, b) => a.source_tier - b.source_tier || LAYER_PREF[a.layer] - LAYER_PREF[b.layer])[0] ?? null;
}

/**
 * Concordância entre camadas/comparador:
 * - 1    → comparador L2 concorda, ou ≥ 2 camadas independentes com citação verificada;
 * - 0.5  → uma camada só (neutro);
 * - 0.25 → algum sinal concorda só parcialmente (contradito x impreciso);
 * - 0    → conflito (um sinal diz confirmado e o modelo acusa, ou vice-versa).
 */
export function layerAgreement(
  verdict: Verdict,
  verified: EvidenceRecord[],
  comparison: IndicatorComparison | null,
): { agreement: number; conflict: boolean; l2_divergent: boolean } {
  const signals: { layer: KbLayer; verdict: Verdict }[] = [];
  if (comparison?.expected_verdict) signals.push({ layer: "L2", verdict: comparison.expected_verdict });
  for (const e of verified) {
    if (e.layer === "L1" && e.factcheck_verdict && e.factcheck_verdict !== "inconclusivo") {
      signals.push({ layer: "L1", verdict: e.factcheck_verdict });
    }
  }
  const l2_divergent = comparison?.expected_verdict != null && comparison.expected_verdict !== verdict;
  let conflict = false;
  let partial = false;
  for (const s of signals) {
    if (s.verdict === verdict) continue;
    if (isAlertVerdict(s.verdict) && isAlertVerdict(verdict)) partial = true;
    else if (verdict !== "inconclusivo") conflict = true;
  }
  if (conflict) return { agreement: 0, conflict, l2_divergent };
  const layers = new Set(verified.map((e) => e.layer));
  let agreement = layers.size >= 2 ? 1 : 0.5;
  if (comparison?.expected_verdict === verdict) agreement = 1;
  if (partial) agreement = Math.min(agreement, 0.25);
  return { agreement, conflict, l2_divergent };
}

export function scoreDecision(input: ScoreInput): ScoreResult {
  const verified = input.evidence.filter((e) => e.quote_verified);
  // evidência fraca da base (entrou junto com a web) não sustenta sozinha: não conta
  // como camada independente, não vira a "melhor fonte" e não tira o acréscimo da web
  const strong = verified.filter((e) => !e.weak);
  const best = bestEvidence(strong.length ? strong : verified);
  // conflito olha tudo (uma checagem fraca que discorda ainda silencia); concordância, só o forte
  const all = layerAgreement(input.verdict, verified, input.comparison);
  const { conflict, l2_divergent } = all;
  const agreement = conflict ? 0 : layerAgreement(input.verdict, strong, input.comparison).agreement;
  const quoteFraction = input.citations_total > 0 ? input.citations_verified / input.citations_total : 0;
  const tierComponent = best ? TIER_WEIGHT[best.source_tier] : 0;
  const conf = Math.min(1, Math.max(0, input.model_confidence));

  const raw =
    SCORE_WEIGHTS.confidence * conf +
    SCORE_WEIGHTS.tier * tierComponent +
    SCORE_WEIGHTS.agreement * agreement +
    SCORE_WEIGHTS.quotes * quoteFraction;
  const final_score = Math.round(Math.min(1, Math.max(0, raw)) * 1e4) / 1e4;

  // web: toda a evidência verificada veio da L4
  const usedWeb = verified.length > 0 && verified.every((e) => e.layer === "L4" || e.weak);
  const kind: ClaimKind = input.kind ?? "fato";
  const rules = KIND_RULES[kind];
  const verdictLevel: AlertLevel | null = input.verdict === "contradito" ? "red" : input.verdict === "impreciso" ? "yellow" : null;
  // opinião e previsão nunca viram vermelho: no máximo "impreciso"
  const capped = verdictLevel === "red" && rules.max_level === "yellow";
  const level: AlertLevel | null = capped ? "yellow" : verdictLevel;
  const threshold = level
    ? (level === "red" ? input.settings.t_red : input.settings.t_yellow) +
      (usedWeb ? input.settings.web_penalty : 0) +
      rules.extra_threshold
    : null;

  const components: Record<string, number | string | boolean> = {
    model_confidence: conf,
    tier: tierComponent,
    agreement,
    quote_fraction: quoteFraction,
    verified_evidence: verified.length,
    used_web: usedWeb,
    kind,
    ...(capped ? { level_capped: true } : {}),
    ...(best ? { best_tier: best.source_tier, best_layer: best.layer } : {}),
    ...(threshold !== null ? { threshold } : {}),
    ...(input.comparison ? { l2_status: input.comparison.status } : {}),
  };
  const layer = best?.layer ?? input.evidence[0]?.layer ?? null;
  const silence = (reason: string): ScoreResult => ({ final_score, alert: null, silence_reason: reason, layer, components, review: false });

  // Regras duras — a ordem define qual motivo aparece no log
  if (input.forced_reason) return silence(input.forced_reason);
  if (input.verdict === "confirmado") return silence("confirmado");
  if (input.verdict === "inconclusivo") return silence("inconclusivo");
  if (l2_divergent) return silence("l2_divergente");
  if (conflict) return silence("camadas_em_conflito");
  if (!best) return silence("sem_citacao_verificada");
  if (best.source_tier >= 4) return silence("fonte_tier_4");
  if (level === "red" && best.source_tier > rules.red_max_tier) {
    return silence(kind === "acusacao" ? "acusacao_vermelho_exige_tier_1" : "vermelho_exige_tier_1_2");
  }
  // opinião, previsão e acusação: só com fonte de nível 1–2, mesmo em amarelo
  if (best.source_tier > rules.max_tier) return silence("tipo_exige_tier_1_2");
  if (!input.correction.trim()) return silence("sem_correcao");
  if (!input.correction_numbers_ok) return silence("numero_sem_fonte");
  if (threshold === null || final_score < threshold) return silence("abaixo_do_threshold");

  return { final_score, alert: level, silence_reason: null, layer, components, review: rules.force_review };
}
