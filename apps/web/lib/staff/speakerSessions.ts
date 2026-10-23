// Mapa de falantes do /editor: rótulos da diarização agrupados por sessão de captura.
// O rótulo é "s{conexão}-{instância}:S{n}" (apps/capture/src/deepgram.ts): a cada reconexão
// do Deepgram ou reinício da captura a numeração recomeça, então "S0" de outra sessão pode
// ser outra pessoa. E o Deepgram cria rótulos para fragmentos de 1–2 s (ensaio de 18/10:
// "1.", "Olá,", "Ok." viraram vozes a mais no mapa).

import { formatDuration } from "@/lib/format";

/** Abaixo disso (soma da fala), o rótulo é fragmento: ruído da diarização. */
export const FRAGMENT_MAX_S = 5;
/** Voz sem mapa com pelo menos isso de fala, na sessão mais recente, pede remapeamento. */
export const REMAP_MIN_S = 20;

export interface SpeakerSegmentRow {
  id: number;
  speaker_label: string;
  text: string;
  /** numeric no banco: pode chegar como string. */
  t_start: number | string;
  t_end: number | string;
  received_at: string;
}

export interface SpeakerLabelStats {
  label: string;
  segments: number;
  /** Soma de t_end − t_start, em segundos. */
  speech_s: number;
  last_at: string | null;
  /** Fala mais recente, para reconhecer a voz. */
  sample: string;
  person: string | null;
}

export interface SpeakerSession {
  /** Prefixo antes de ":" ("s1-7e221b"); "" = rótulo sem sessão. */
  session: string;
  last_at: string | null;
  latest: boolean;
  /** Rótulos com pelo menos FRAGMENT_MAX_S de fala. */
  voices: SpeakerLabelStats[];
  /** Fragmentos curtos: recolhidos no painel, ainda mapeáveis. */
  fragments: SpeakerLabelStats[];
}

export interface SpeakerSessionsView {
  /** Da mais recente (último trecho recebido) para a mais antiga. */
  sessions: SpeakerSession[];
  /** A sessão mais recente tem voz longa sem mapa e alguma sessão anterior tem mapa. */
  remap: boolean;
}

export function sessionOf(label: string): string {
  const i = label.indexOf(":");
  return i === -1 ? "" : label.slice(0, i);
}

const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);
const byName = (a: string, b: string) => a.localeCompare(b, "pt-BR", { numeric: true });

export function groupSpeakerSessions(rows: readonly SpeakerSegmentRow[], map: Readonly<Record<string, string>>): SpeakerSessionsView {
  const labels = new Map<string, SpeakerLabelStats & { last_id: number }>();
  const get = (label: string) => {
    let cur = labels.get(label);
    if (!cur) {
      cur = { label, segments: 0, speech_s: 0, last_at: null, sample: "", person: map[label] ?? null, last_id: -1 };
      labels.set(label, cur);
    }
    return cur;
  };
  for (const r of rows) {
    const cur = get(r.speaker_label);
    cur.segments += 1;
    const dur = Number(r.t_end) - Number(r.t_start);
    if (Number.isFinite(dur) && dur > 0) cur.speech_s += dur;
    if (time(r.received_at) > time(cur.last_at)) cur.last_at = r.received_at;
    if (r.id > cur.last_id) {
      cur.last_id = r.id;
      cur.sample = r.text;
    }
  }
  // mapeado sem trecho carregado continua aparecendo (dá para desfazer o mapa)
  for (const label of Object.keys(map)) get(label);

  const bySession = new Map<string, SpeakerLabelStats[]>();
  for (const { last_id: _id, ...l } of labels.values()) {
    const s = sessionOf(l.label);
    const list = bySession.get(s) ?? [];
    list.push(l);
    bySession.set(s, list);
  }
  const sessions: SpeakerSession[] = [...bySession.entries()]
    .map(([session, list]) => {
      list.sort((a, b) => byName(a.label, b.label));
      const last = list.reduce<string | null>((m, l) => (time(l.last_at) > time(m) ? l.last_at : m), null);
      return {
        session,
        last_at: last,
        latest: false,
        voices: list.filter((l) => l.speech_s >= FRAGMENT_MAX_S),
        fragments: list.filter((l) => l.speech_s < FRAGMENT_MAX_S),
      };
    })
    .sort((a, b) => time(b.last_at) - time(a.last_at) || byName(b.session, a.session));
  if (sessions[0]) sessions[0].latest = true;

  const [latest, ...older] = sessions;
  const remap =
    !!latest &&
    latest.voices.some((l) => l.speech_s >= REMAP_MIN_S && !l.person) &&
    older.some((s) => [...s.voices, ...s.fragments].some((l) => l.person));
  return { sessions, remap };
}

/** "0,4 s", "8,1 s", "1 min 21 s" */
export function formatSpeech(seconds: number): string {
  return seconds < 10 ? `${seconds.toFixed(1).replace(".", ",")} s` : formatDuration(Math.round(seconds));
}
