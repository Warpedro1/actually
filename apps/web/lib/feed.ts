// Montagem do feed público de alertas — funções puras, usadas no servidor
// (GET /api/alerts) e no cliente (Realtime + polling). Testadas em test/feed.test.ts.

import type { Alert, AlertWithEvidence, DebateSettings, Evidence } from "@actually/db";
import { formatTime } from "./format";

export type FeedEvidence = AlertWithEvidence["evidence"][number];

export interface FeedAlert extends AlertWithEvidence {
  /** Quando a afirmação original foi verificada (só para is_repeat). */
  repeat_verified_at: string | null;
}

/** Quem disse o quê — só é usado se o debate permitir atribuição. */
export interface Attribution {
  show: boolean;
  /** speaker_label → pessoa (do speaker_map). */
  speakers: Record<string, string>;
}

export interface FeedDebate {
  id: string;
  slug: string;
  title: string;
  status: "scheduled" | "live" | "ended";
}

/** Resposta de GET /api/alerts. */
export interface AlertsPayload {
  debate: FeedDebate;
  alerts: FeedAlert[];
  attribution: Attribution;
  server_time: string;
}

export const NEUTRAL_ATTRIBUTION = "Afirmação feita no debate";

/** Opções do mapeamento de speaker no editor. */
export const PEOPLE = ["Lula", "Flávio Bolsonaro", "Mediação", "Outro"] as const;
export type Person = (typeof PEOPLE)[number];

/** Pessoas que nunca são nomeadas no alerta (não identificam um candidato). */
const NEVER_NAMED = new Set<string>(["Outro"]);

export const VERDICT_LABEL: Record<FeedAlert["verdict"], { icon: string; text: string }> = {
  contradito: { icon: "🔴", text: "Contradito pelas fontes" },
  impreciso: { icon: "🟡", text: "Impreciso" },
};

export function attributionFrom(
  settings: Pick<DebateSettings, "show_attribution">,
  rows: { speaker_label: string; person: string }[],
): Attribution {
  const speakers: Record<string, string> = {};
  for (const r of rows) speakers[r.speaker_label] = r.person;
  return { show: settings.show_attribution, speakers };
}

/** Nome do candidato só com show_attribution ligado e speaker mapeado. */
export function resolvePerson(speakerLabel: string | null, attribution: Attribution): string | null {
  if (!attribution.show || !speakerLabel) return null;
  const person = attribution.speakers[speakerLabel];
  if (!person || NEVER_NAMED.has(person)) return null;
  return person;
}

export function attributionText(alert: Pick<FeedAlert, "person">): string {
  return alert.person ?? NEUTRAL_ATTRIBUTION;
}

/** Evidências exibíveis: só trecho verificado, melhor tier primeiro. */
export function publicEvidence(
  rows: Pick<Evidence, "url" | "source_name" | "source_tier" | "quote" | "evidence_type" | "published_at" | "quote_verified">[],
): FeedEvidence[] {
  return rows
    .filter((e) => e.quote_verified && /^https?:\/\//i.test(e.url) && e.quote.trim().length > 0)
    .sort((a, b) => a.source_tier - b.source_tier)
    .map(({ url, source_name, source_tier, quote, evidence_type, published_at }) => ({
      url,
      source_name,
      source_tier,
      quote,
      evidence_type,
      published_at,
    }));
}

export function toFeedAlert(
  alert: Alert,
  evidence: FeedEvidence[],
  attribution: Attribution,
  repeatVerifiedAt: string | null = null,
): FeedAlert {
  return {
    ...alert,
    evidence,
    person: resolvePerson(alert.speaker_label, attribution),
    repeat_verified_at: alert.is_repeat ? repeatVerifiedAt : null,
  };
}

/** Momento em que o alerta apareceu para o público. */
export function feedTime(a: Pick<Alert, "published_at" | "created_at">): string {
  return a.published_at ?? a.created_at;
}

function compareFeed(a: FeedAlert, b: FeedAlert): number {
  const t = Date.parse(feedTime(b)) - Date.parse(feedTime(a));
  if (t !== 0) return t;
  const c = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (c !== 0) return c;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Junta alertas novos ao feed: deduplica por id (a versão nova vence, mas não
 * perde evidências já carregadas), descarta o que não está publicado e ordena
 * do mais novo para o mais antigo.
 */
export function mergeAlerts(current: readonly FeedAlert[], incoming: readonly FeedAlert[]): FeedAlert[] {
  const byId = new Map<string, FeedAlert>();
  for (const a of current) byId.set(a.id, a);
  for (const a of incoming) {
    const prev = byId.get(a.id);
    if (!prev) {
      byId.set(a.id, a);
      continue;
    }
    byId.set(a.id, {
      ...prev,
      ...a,
      evidence: a.evidence.length > 0 ? a.evidence : prev.evidence,
      repeat_verified_at: a.repeat_verified_at ?? prev.repeat_verified_at,
    });
  }
  return [...byId.values()].filter((a) => a.status === "published").sort(compareFeed);
}

/** Reaplica a atribuição (quando settings/speaker_map mudam). */
export function applyAttribution(alerts: readonly FeedAlert[], attribution: Attribution): FeedAlert[] {
  return alerts.map((a) => {
    const person = resolvePerson(a.speaker_label, attribution);
    return person === a.person ? a : { ...a, person };
  });
}

/** "Repetido — já verificado às HH:MM" (ou null se não é repetição). */
export function repeatText(alert: FeedAlert, feed: readonly FeedAlert[] = []): string | null {
  if (!alert.is_repeat) return null;
  let at = alert.repeat_verified_at;
  if (!at && alert.repeat_of) {
    const orig = feed.find((a) => a.id === alert.repeat_of);
    if (orig) at = orig.created_at;
  }
  return at ? `Repetido — já verificado às ${formatTime(at)}` : "Repetido — já verificado anteriormente";
}

/** Maior published_at conhecido — cursor do polling. */
export function latestPublishedAt(alerts: readonly FeedAlert[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const a of alerts) {
    if (!a.published_at) continue;
    const ms = Date.parse(a.published_at);
    if (ms > bestMs) {
      bestMs = ms;
      best = a.published_at;
    }
  }
  return best;
}

/**
 * Monta o feed a partir das linhas cruas do banco (usado por GET /api/alerts).
 * `repeatOrigins` mapeia alert.id original → created_at.
 */
export function buildFeed(input: {
  alerts: Alert[];
  evidence: (Pick<Evidence, "verification_id" | "url" | "source_name" | "source_tier" | "quote" | "evidence_type" | "published_at" | "quote_verified">)[];
  attribution: Attribution;
  repeatOrigins?: Record<string, string>;
}): FeedAlert[] {
  const evByVerification = new Map<string, typeof input.evidence>();
  for (const e of input.evidence) {
    const list = evByVerification.get(e.verification_id) ?? [];
    list.push(e);
    evByVerification.set(e.verification_id, list);
  }
  const feed = input.alerts.map((a) =>
    toFeedAlert(
      a,
      publicEvidence(evByVerification.get(a.verification_id) ?? []),
      input.attribution,
      a.repeat_of ? (input.repeatOrigins?.[a.repeat_of] ?? null) : null,
    ),
  );
  // Correção sem fonte não existe: sem evidência verificada, não mostra.
  return mergeAlerts([], feed.filter((a) => a.evidence.length > 0));
}
