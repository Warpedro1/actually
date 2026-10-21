"use client";

import { resolveSettings, type Alert, type CaptureAgent, type CaptureMachine, type Debate, type MachineDesired } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { VERDICT_LABEL } from "@/lib/feed";
import { formatTimeSec } from "@/lib/format";
import { countByPerson, latencyStats, type PersonCount, type StageStats } from "@/lib/staff/stats";
import { ApiUsagePanel } from "./ApiUsagePanel";
import { DebateForms } from "./DebateForms";
import { DebatePicker } from "./DebatePicker";
import { KbPanel } from "./KbPanel";
import { MachinesPanel } from "./MachinesPanel";
import { SettingsForm } from "./SettingsForm";
import { Card, ErrorText, Pill, errMsg } from "./ui";
import { useDebates, useNow, useTableChanges } from "./useStaffData";

export function AdminApp({ client }: { client: SupabaseClient }) {
  const { debates, selected, select, reload, error } = useDebates(client);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Admin</h1>
        <DebatePicker debates={debates} selected={selected} onSelect={select} />
      </div>
      <ErrorText>{error}</ErrorText>
      <nav aria-label="Seções" className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {[
          ["maquinas", "Máquinas"],
          ["debate", "Debate"],
          ["config", "Configurações"],
          ["latencia", "Latência"],
          ["neutralidade", "Neutralidade"],
          ["alertas", "Alertas"],
          ["base", "Base de conhecimento"],
          ["uso", "Uso das APIs"],
        ].map(([id, t]) => (
          <a key={id} href={`#${id}`} className="text-muted underline hover:text-fg">
            {t}
          </a>
        ))}
      </nav>
      <LiveMachines client={client} debates={debates} selected={selected} />
      <DebateForms client={client} selected={selected} onSaved={reload} onCreated={(id) => void reload().then(() => select(id))} />
      {selected ? (
        <>
          <SettingsForm client={client} debate={selected} onSaved={reload} />
          <LatencyPanel client={client} debateId={selected.id} />
          <NeutralityPanel client={client} debateId={selected.id} />
          <AlertsTable client={client} debateId={selected.id} />
        </>
      ) : null}
      <KbPanel client={client} />
      <ApiUsagePanel client={client} />
    </div>
  );
}

/** Painel de máquinas ligado ao Supabase (Realtime em capture_machines + polling dos agentes). */
function LiveMachines({ client, debates, selected }: { client: SupabaseClient; debates: Debate[]; selected: Debate | null }) {
  const [machines, setMachines] = useState<CaptureMachine[]>([]);
  const [agents, setAgents] = useState<CaptureAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1000);

  const loadMachines = useCallback(async () => {
    const { data, error: err } = await client.from("capture_machines").select("*").order("name");
    if (err) return setError(`Máquinas: ${errMsg(err)}`);
    setMachines((data ?? []) as CaptureMachine[]);
    setError(null);
  }, [client]);

  const loadAgents = useCallback(async () => {
    if (!selected) return setAgents([]);
    const { data, error: err } = await client
      .from("capture_agents")
      .select("*")
      .eq("debate_id", selected.id)
      .order("created_at", { ascending: false });
    if (err) return setError(`Agentes: ${errMsg(err)}`);
    setAgents((data ?? []) as CaptureAgent[]);
  }, [client, selected]);

  const rt = useTableChanges(client, "capture_machines", undefined, loadMachines);

  useEffect(() => {
    void loadMachines();
    void loadAgents();
    // capture_agents não está no Realtime: polling curto. Máquinas: só se o Realtime cair.
    const id = setInterval(() => {
      void loadAgents();
      if (rt !== "live") void loadMachines();
    }, rt === "live" ? 2000 : 3000);
    return () => clearInterval(id);
  }, [loadMachines, loadAgents, rt]);

  const onSaveDesired = useCallback(
    async (machineId: string, desired: MachineDesired) => {
      const { error: err } = await client.from("capture_machines").update({ desired }).eq("id", machineId);
      if (err) return errMsg(err);
      await loadMachines();
      return null;
    },
    [client, loadMachines],
  );

  const onSetActive = useCallback(
    async (agentId: string) => {
      const { error: err } = await client.rpc("capture_set_active", { p_agent_id: agentId });
      if (err) return errMsg(err);
      await loadAgents();
      return null;
    },
    [client, loadAgents],
  );

  return (
    <>
      <ErrorText>{error}</ErrorText>
      <MachinesPanel
        machines={machines}
        agents={agents}
        debates={debates}
        defaultDebateSlug={selected?.slug ?? null}
        failoverAfterS={resolveSettings(selected?.settings).failover_after_s}
        now={now}
        realtime={rt}
        onSaveDesired={onSaveDesired}
        onSetActive={onSetActive}
      />
    </>
  );
}

const ms = (v: number | null) => (v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

function LatencyPanel({ client, debateId }: { client: SupabaseClient; debateId: string }) {
  const [stats, setStats] = useState<StageStats[] | null>(null);
  const [n, setN] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await client
      .from("verifications")
      .select("latency_ms, created_at, claims!inner(debate_id)")
      .eq("claims.debate_id", debateId)
      .order("created_at", { ascending: false })
      .limit(300);
    if (err) return setError(errMsg(err));
    const rows = (data ?? []) as { latency_ms: Record<string, number> | null }[];
    setN(rows.length);
    setStats(latencyStats(rows));
    setError(null);
  }, [client, debateId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Card id="latencia" title="Latência por etapa" actions={<span className="text-xs text-muted">últimas {n} verificações</span>}>
      <ErrorText>{error}</ErrorText>
      {!stats ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : stats.length === 0 ? (
        <p className="text-sm text-muted">Sem verificações ainda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Etapa</th>
                <th className="py-1 pr-3 text-right font-medium">p50</th>
                <th className="py-1 pr-3 text-right font-medium">p95</th>
                <th className="py-1 text-right font-medium">n</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.stage} className={`border-t border-border ${s.stage === "total" ? "font-semibold" : ""}`}>
                  <td className="py-1.5 pr-3">{s.stage}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{ms(s.p50)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{ms(s.p95)}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted">{s.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function NeutralityPanel({ client, debateId }: { client: SupabaseClient; debateId: string }) {
  const [rows, setRows] = useState<PersonCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [alerts, speakers] = await Promise.all([
      client.from("alerts").select("speaker_label, status, verdict").eq("debate_id", debateId).limit(5000),
      client.from("speaker_map").select("speaker_label, person").eq("debate_id", debateId),
    ]);
    if (alerts.error || speakers.error) return setError(errMsg(alerts.error ?? speakers.error));
    const map: Record<string, string> = {};
    for (const s of (speakers.data ?? []) as { speaker_label: string; person: string }[]) map[s.speaker_label] = s.person;
    setRows(countByPerson((alerts.data ?? []) as Pick<Alert, "speaker_label" | "status" | "verdict">[], map));
    setError(null);
  }, [client, debateId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <Card id="neutralidade" title="Neutralidade — alertas por pessoa">
      <p className="mb-2 text-xs text-muted">
        Mesmas regras para todos. Desequilíbrio grande pode indicar problema do sistema (ou não) — vale olhar os casos.
      </p>
      <ErrorText>{error}</ErrorText>
      {!rows ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Nenhum alerta ainda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Quem</th>
                <th className="py-1 pr-3 text-right font-medium">🔴 publicados</th>
                <th className="py-1 pr-3 text-right font-medium">🟡 publicados</th>
                <th className="py-1 pr-3 text-right font-medium">Pendentes</th>
                <th className="py-1 text-right font-medium">Rejeitados</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.who} className="border-t border-border">
                  <td className="py-1.5 pr-3">{r.who}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.published_red}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.published_yellow}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{r.pending}</td>
                  <td className="py-1.5 text-right tabular-nums">{r.rejected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const STATUS_TONE = { published: "ok", pending_review: "warn", rejected: "neutral" } as const;
const STATUS_TEXT = { published: "publicado", pending_review: "pendente", rejected: "rejeitado" } as const;

function AlertsTable({ client, debateId }: { client: SupabaseClient; debateId: string }) {
  const [rows, setRows] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await client
      .from("alerts")
      .select("*")
      .eq("debate_id", debateId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (err) return setError(errMsg(err));
    setRows((data ?? []) as Alert[]);
    setError(null);
  }, [client, debateId]);

  useEffect(() => {
    void load();
  }, [load]);
  useTableChanges(client, "alerts", `debate_id=eq.${debateId}`, load);

  return (
    <Card id="alertas" title="Alertas (últimos 100)">
      <ErrorText>{error}</ErrorText>
      {!rows ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Nenhum alerta.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-start sm:gap-3">
              <span className="shrink-0 text-xs tabular-nums text-muted sm:w-20">{formatTimeSec(a.created_at)}</span>
              <span className="flex shrink-0 gap-1">
                <Pill tone={STATUS_TONE[a.status]}>{STATUS_TEXT[a.status]}</Pill>
                <span aria-label={VERDICT_LABEL[a.verdict].text}>{VERDICT_LABEL[a.verdict].icon}</span>
                {a.is_repeat ? <Pill>rep.</Pill> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2">“{a.claim_text}”</span>
                {a.reject_reason ? <span className="block text-xs text-muted">Motivo: {a.reject_reason}</span> : null}
              </span>
              <span className="shrink-0 text-xs text-muted">{a.speaker_label ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
