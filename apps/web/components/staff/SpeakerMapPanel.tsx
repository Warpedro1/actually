"use client";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PEOPLE } from "@/lib/feed";
import { formatTimeSec } from "@/lib/format";
import {
  formatSpeech, groupSpeakerSessions, REMAP_MIN_S, type SpeakerLabelStats, type SpeakerSegmentRow, type SpeakerSession,
} from "@/lib/staff/speakerSessions";
import { Card, ErrorText, inputCls, Pill, errMsg } from "./ui";

/** Teto padrão de linhas por resposta do PostgREST no Supabase (o .limit maior é cortado nele). */
const PAGE = 1000;
/** Ids já atribuídos que podem ficar visíveis depois de um id maior (inserções concorrentes). */
const OVERLAP = 50;

/**
 * Mapeamento speaker_label (diarização) → pessoa. O nome só aparece para o público com
 * settings.show_attribution ligado; "Mediação" vale sempre: tira aquela voz da checagem.
 * Os rótulos vêm agrupados por sessão de captura (lib/staff/speakerSessions.ts).
 */
export function SpeakerMapPanel({ client, user, debateId }: { client: SupabaseClient; user: User; debateId: string }) {
  const [loaded, setLoaded] = useState<{ debateId: string; rows: SpeakerSegmentRow[] } | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // segments é append-only: a 1ª carga traz tudo (em páginas) e as seguintes só o que chegou depois
  const cache = useRef<{ debateId: string; rows: Map<number, SpeakerSegmentRow>; maxId: number } | null>(null);

  const load = useCallback(async () => {
    if (cache.current?.debateId !== debateId) cache.current = { debateId, rows: new Map(), maxId: 0 };
    const c = cache.current;
    const loadSegments = async () => {
      let after = Math.max(0, c.maxId - OVERLAP);
      // um debate de 2 h tem ~1.200 trechos; o que não couber aqui vem na próxima rodada
      for (let page = 0; page < 5; page++) {
        const res = await client
          .from("segments")
          .select("id, speaker_label, text, t_start, t_end, received_at")
          .eq("debate_id", debateId)
          .not("speaker_label", "is", null)
          .gt("id", after)
          .order("id", { ascending: true })
          .limit(PAGE);
        if (res.error) return res.error;
        const data = (res.data ?? []) as SpeakerSegmentRow[];
        for (const r of data) c.rows.set(r.id, r);
        if (!data.length) break;
        after = data[data.length - 1]!.id;
        c.maxId = Math.max(c.maxId, after);
        if (data.length < PAGE) break;
      }
      return null;
    };
    const [segErr, mapRes] = await Promise.all([
      loadSegments(),
      client.from("speaker_map").select("speaker_label, person").eq("debate_id", debateId),
    ]);
    if (cache.current !== c) return; // trocou de debate no meio
    if (segErr || mapRes.error) return setError(errMsg(segErr ?? mapRes.error));
    const m: Record<string, string> = {};
    for (const r of (mapRes.data ?? []) as { speaker_label: string; person: string }[]) m[r.speaker_label] = r.person;
    setLoaded({ debateId, rows: [...c.rows.values()] });
    setMap(m);
    setError(null);
  }, [client, debateId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  const rows = loaded?.debateId === debateId ? loaded.rows : null;
  const view = useMemo(() => groupSpeakerSessions(rows ?? [], rows ? map : {}), [rows, map]);

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
        Vozes detectadas pela transcrição, por sessão de captura: a cada reinício ou reconexão os rótulos recomeçam.
        Marque a voz da mediação e dos jornalistas como “Mediação” logo nas primeiras falas (e de novo depois de cada
        reconexão): ela deixa de ser checada. Na dúvida, deixe sem mapa. O nome dos candidatos só aparece para o público
        se a atribuição estiver ligada.
      </p>
      <ErrorText>{error}</ErrorText>
      {view.remap ? (
        <p role="alert" className="mb-3 rounded-lg border border-yellow-border bg-yellow-bg px-3 py-2 text-sm text-yellow-fg">
          Nova sessão de captura: os rótulos mudaram — mapeie de novo a mediação e os candidatos.
        </p>
      ) : null}
      {view.sessions.length === 0 ? (
        <p className="text-sm text-muted">{rows ? "Nenhuma voz detectada ainda." : "Carregando vozes…"}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {view.sessions.map((s) => (
            <SessionBlock key={s.session} session={s} map={map} saving={saving} onAssign={(l, p) => void assign(l, p)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function SessionBlock({
  session: s,
  map,
  saving,
  onAssign,
}: {
  session: SpeakerSession;
  map: Record<string, string>;
  saving: string | null;
  onAssign: (label: string, person: string) => void;
}) {
  const mappedFragments = s.fragments.filter((l) => map[l.label]).length;
  const item = (l: SpeakerLabelStats) => (
    <LabelItem key={l.label} stats={l} person={map[l.label] ?? ""} saving={saving === l.label} warn={s.latest} onAssign={onAssign} />
  );
  // aberta só a mais recente; o React não mexe no "open" enquanto ela continuar a mais recente
  return (
    <details open={s.latest} className="rounded-lg border border-border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        Sessão {s.session || "sem identificação"}
        {s.latest ? <span className="font-normal text-muted"> (atual)</span> : null}
        <span className="block text-xs font-normal text-muted">
          {plural(s.voices.length, "voz", "vozes")}
          {s.fragments.length ? ` + ${plural(s.fragments.length, "fragmento", "fragmentos")}` : ""}
          {s.last_at ? ` · último trecho às ${formatTimeSec(s.last_at)}` : ""}
        </span>
        {s.latest ? null : (
          <span className="mt-1 block text-xs font-normal text-yellow-fg">
            Sessão anterior: a captura reiniciou ou reconectou e os rótulos não se repetem entre sessões.
          </span>
        )}
      </summary>
      <div className="flex flex-col gap-3 border-t border-border p-3">
        {s.voices.length ? <ul className="flex flex-col gap-3">{s.voices.map(item)}</ul> : null}
        {s.fragments.length ? (
          <details className="rounded-lg border border-border">
            <summary className="cursor-pointer px-3 py-2 text-xs text-muted">
              Fragmentos curtos (ruído da diarização): {plural(s.fragments.length, "rótulo", "rótulos")} com menos de 5 s
              de fala{mappedFragments ? `, ${mappedFragments} mapeado${mappedFragments === 1 ? "" : "s"}` : ""}
            </summary>
            <ul className="flex flex-col gap-3 border-t border-border p-3">{s.fragments.map(item)}</ul>
          </details>
        ) : null}
      </div>
    </details>
  );
}

function LabelItem({
  stats: l,
  person,
  saving,
  warn,
  onAssign,
}: {
  stats: SpeakerLabelStats;
  person: string;
  saving: boolean;
  /** Sessão mais recente: voz longa sem mapa ganha destaque. */
  warn: boolean;
  onAssign: (label: string, person: string) => void;
}) {
  const id = `spk-${l.label}`;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm font-medium" htmlFor={id}>
          {l.label}
        </label>
        {saving ? (
          <span className="text-xs text-muted">salvando…</span>
        ) : warn && !person && l.speech_s >= REMAP_MIN_S ? (
          <Pill tone="warn">sem mapa</Pill>
        ) : null}
      </div>
      <p id={`${id}-info`} className="text-xs tabular-nums text-muted">
        {plural(l.segments, "trecho", "trechos")} · {formatSpeech(l.speech_s)} de fala
        {l.last_at ? ` · último às ${formatTimeSec(l.last_at)}` : ""}
      </p>
      <select id={id} aria-describedby={`${id}-info`} value={person} onChange={(e) => onAssign(l.label, e.target.value)} className={inputCls}>
        <option value="">— não mapeado —</option>
        {PEOPLE.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      {l.sample ? <p className="line-clamp-2 text-xs italic text-muted">“{l.sample}”</p> : null}
    </li>
  );
}
