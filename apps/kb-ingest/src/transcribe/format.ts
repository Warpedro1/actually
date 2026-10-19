// Transcrição normalizada (formato próprio, independente do provedor) e
// conversão da resposta pré-gravada do Deepgram (/v1/listen com utterances=true).
// Campos do Deepgram conforme o SDK oficial (@deepgram/sdk): results.utterances[]
// {start, end, speaker, transcript, confidence}; results.channels[0].alternatives[0].transcript.

export interface Utterance {
  speaker: string | null;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  source: string;
  provider: "deepgram" | "apify" | "manual";
  created_at: string;
  duration_s: number | null;
  utterances: Utterance[];
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    utterances?: { start?: number; end?: number; speaker?: number; transcript?: string }[];
    channels?: { alternatives?: { transcript?: string }[] }[];
  };
}

export function fromDeepgram(json: unknown, source: string): Transcript {
  const r = json as DeepgramResponse;
  const utts = (r.results?.utterances ?? [])
    .filter((u) => u.transcript?.trim())
    .map((u) => ({
      speaker: u.speaker === undefined ? null : `Falante ${u.speaker}`,
      start: u.start ?? 0,
      end: u.end ?? u.start ?? 0,
      text: u.transcript!.trim(),
    }));
  if (!utts.length) {
    const t = r.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
    if (t) utts.push({ speaker: null, start: 0, end: r.metadata?.duration ?? 0, text: t });
  }
  return {
    source,
    provider: "deepgram",
    created_at: new Date().toISOString(),
    duration_s: r.metadata?.duration ?? null,
    utterances: utts,
  };
}

export function formatTimestamp(s: number): string {
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Texto legível: "[mm:ss] Falante 0: ..." — falas seguidas do mesmo falante são
 * juntadas. `speakerNames` troca "Falante 0" por um nome (só se confirmado por humano).
 */
export function transcriptToText(t: Transcript, speakerNames: Record<string, string> = {}): string {
  const lines: string[] = [];
  let cur: Utterance | null = null;
  const flush = () => {
    if (!cur) return;
    const who = cur.speaker ? speakerNames[cur.speaker] ?? cur.speaker : null;
    lines.push(`[${formatTimestamp(cur.start)}] ${who ? `${who}: ` : ""}${cur.text}`);
  };
  for (const u of t.utterances) {
    if (cur && cur.speaker === u.speaker && u.start - cur.end < 2) {
      cur = { ...cur, end: u.end, text: `${cur.text} ${u.text}` };
    } else {
      flush();
      cur = { ...u };
    }
  }
  flush();
  return lines.join("\n");
}

/** "0=Lula,1=Flávio Bolsonaro" → {"Falante 0": "Lula", ...} */
export function parseSpeakerMap(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const m = /^\s*(\d+)\s*=\s*(.+?)\s*$/.exec(part);
    if (m) out[`Falante ${m[1]}`] = m[2]!;
  }
  return out;
}

/** Arquivo local → texto: .txt como está; .json no formato Transcript, Deepgram cru ou {text}. */
export function localFileToText(content: string, filename: string, speakerNames: Record<string, string> = {}): string {
  if (!/\.json$/i.test(filename)) return content;
  const j = JSON.parse(content) as Record<string, unknown>;
  if (Array.isArray(j.utterances)) return transcriptToText(j as unknown as Transcript, speakerNames);
  if (j.results) return transcriptToText(fromDeepgram(j, filename), speakerNames);
  if (typeof j.text === "string") return j.text;
  throw new Error(`${filename}: JSON sem utterances, results ou text`);
}
