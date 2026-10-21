"use client";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { PEOPLE } from "@/lib/feed";
import { Card, ErrorText, inputCls, errMsg } from "./ui";

interface LabelInfo {
  label: string;
  count: number;
  sample: string;
}

/**
 * Mapeamento speaker_label (diarização) → pessoa. O nome só aparece para o público com
 * settings.show_attribution ligado; "Mediação" vale sempre: tira aquela voz da checagem.
 */
export function SpeakerMapPanel({ client, user, debateId }: { client: SupabaseClient; user: User; debateId: string }) {
  const [labels, setLabels] = useState<LabelInfo[]>([]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [segs, rows] = await Promise.all([
      client
        .from("segments")
        .select("speaker_label, text")
        .eq("debate_id", debateId)
        .not("speaker_label", "is", null)
        .order("id", { ascending: false })
        .limit(2000),
      client.from("speaker_map").select("speaker_label, person").eq("debate_id", debateId),
    ]);
    if (segs.error || rows.error) return setError(errMsg(segs.error ?? rows.error));
    const info = new Map<string, LabelInfo>();
    for (const s of (segs.data ?? []) as { speaker_label: string; text: string }[]) {
      const cur = info.get(s.speaker_label);
      if (cur) cur.count += 1;
      else info.set(s.speaker_label, { label: s.speaker_label, count: 1, sample: s.text });
    }
    const m: Record<string, string> = {};
    for (const r of (rows.data ?? []) as { speaker_label: string; person: string }[]) {
      m[r.speaker_label] = r.person;
      if (!info.has(r.speaker_label)) info.set(r.speaker_label, { label: r.speaker_label, count: 0, sample: "" });
    }
    setLabels([...info.values()].sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { numeric: true })));
    setMap(m);
    setError(null);
  }, [client, debateId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  async function assign(label: string, person: string) {
    setSaving(label);
    setError(null);
    const res = person
      ? await client.from("speaker_map").upsert(
          { debate_id: debateId, speaker_label: label, person, confirmed_by: user.id, updated_at: new Date().toISOString() },
          { onConflict: "debate_id,speaker_label" },
        )
      : await client.from("speaker_map").delete().eq("debate_id", debateId).eq("speaker_label", label);
    setSaving(null);
    if (res.error) return setError(errMsg(res.error));
    setMap((m) => {
      const next = { ...m };
      if (person) next[label] = person;
      else delete next[label];
      return next;
    });
  }

  return (
    <Card title="Quem está falando">
      <p className="mb-3 text-xs text-muted">
        Vozes detectadas pela transcrição. Marque a voz da mediação e dos jornalistas como “Mediação” logo nas
        primeiras falas (e de novo se aparecer voz nova depois de uma reconexão): ela deixa de ser checada. Na dúvida,
        deixe sem mapa. O nome dos candidatos só aparece para o público se a atribuição estiver ligada.
      </p>
      <ErrorText>{error}</ErrorText>
      {labels.length === 0 ? (
        <p className="text-sm text-muted">Nenhuma voz detectada ainda.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {labels.map((l) => (
            <li key={l.label} className="flex flex-col gap-1">
              <label className="flex items-center justify-between gap-2 text-sm font-medium" htmlFor={`spk-${l.label}`}>
                <span>
                  {l.label} <span className="text-xs font-normal text-muted">({l.count} falas)</span>
                </span>
                {saving === l.label ? <span className="text-xs text-muted">salvando…</span> : null}
              </label>
              <select
                id={`spk-${l.label}`}
                value={map[l.label] ?? ""}
                onChange={(e) => void assign(l.label, e.target.value)}
                className={inputCls}
              >
                <option value="">— não mapeado —</option>
                {PEOPLE.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              {l.sample ? <p className="line-clamp-2 text-xs italic text-muted">“{l.sample}”</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
