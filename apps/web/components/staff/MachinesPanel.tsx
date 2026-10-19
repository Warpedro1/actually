"use client";

import { MachineDesiredSchema, type CaptureAgent, type CaptureMachine, type Debate, type MachineDesired } from "@actually/db";
import { useEffect, useState } from "react";
import { desiredSourceError } from "@/lib/captureSource";
import { formatDuration, formatTimeSec, isoToLocalInput, localInputToIso, secondsSince } from "@/lib/format";
import {
  audioPercent,
  describeDesired,
  isActiveMachine,
  isSilentLevel,
  machineOnline,
  machineWarnings,
  REPORTED_TEXT,
  SOURCE_TEXT,
  suggestStartAt,
  START_LEAD_MIN,
} from "@/lib/staff/machines";
import { Button, Card, ErrorText, Field, inputCls, OkText, Pill } from "./ui";

export type PanelDebate = Pick<Debate, "id" | "slug" | "title" | "scheduled_at" | "youtube_url">;

export interface MachinesPanelProps {
  machines: CaptureMachine[];
  /** capture_agents do debate selecionado. */
  agents: CaptureAgent[];
  debates: PanelDebate[];
  defaultDebateSlug: string | null;
  /** Janela de failover (s) do debate selecionado — idade máxima do heartbeat "vivo". */
  failoverAfterS: number;
  now: number;
  realtime: "connecting" | "live" | "down" | "demo";
  /** Retornam mensagem de erro ou null. */
  onSaveDesired: (machineId: string, desired: MachineDesired) => Promise<string | null>;
  onSetActive: (agentId: string) => Promise<string | null>;
}

/**
 * Controle remoto da captura: estado de cada máquina (online, áudio, último
 * segmento, erros), estado desejado (iniciar/agendar/parar) e agentes do debate.
 */
export function MachinesPanel(props: MachinesPanelProps) {
  const { machines, agents, now, realtime } = props;

  // Desde quando cada máquina está com nível de áudio em silêncio (observado aqui).
  const [silentSince, setSilentSince] = useState<Record<string, number>>({});
  useEffect(() => {
    setSilentSince((prev) => {
      const next: Record<string, number> = {};
      for (const m of machines) {
        if (m.reported.state === "running" && isSilentLevel(m.reported.audio_level_db)) next[m.id] = prev[m.id] ?? Date.now();
      }
      return next;
    });
  }, [machines]);

  const sorted = [...machines].sort(
    (a, b) =>
      Number(isActiveMachine(b, agents)) - Number(isActiveMachine(a, agents)) ||
      Number(machineOnline(b, now)) - Number(machineOnline(a, now)) ||
      a.name.localeCompare(b.name),
  );
  const activeOffline = sorted.some((m) => isActiveMachine(m, agents) && !machineOnline(m, now));

  return (
    <Card
      id="maquinas"
      title="Máquinas de captura"
      actions={
        <span className="text-xs text-muted">
          {realtime === "live"
            ? "Tempo real"
            : realtime === "demo"
              ? "Demonstração (dados fictícios)"
              : realtime === "down"
                ? "Realtime fora — atualizando a cada 3 s"
                : "Conectando…"}
        </span>
      }
    >
      {activeOffline ? (
        <p role="alert" className="mb-3 rounded-lg border-2 border-red-border bg-red-bg px-3 py-2 text-sm font-semibold text-red-fg">
          ⚠ A máquina ativa está offline. Confira os agentes abaixo.
        </p>
      ) : null}
      {sorted.length === 0 ? (
        <p className="text-sm text-muted">
          Nenhuma máquina conectada. Rode <code>capture daemon</code> na máquina de captura; ela aparece aqui no
          primeiro contato.
        </p>
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {sorted.map((m) => (
            <li key={m.id}>
              <MachineCard {...props} machine={m} silentSince={silentSince[m.id] ?? null} />
            </li>
          ))}
        </ul>
      )}
      <AgentsTable {...props} />
    </Card>
  );
}

function AudioMeter({ db }: { db: number | null | undefined }) {
  const pct = audioPercent(db);
  const silent = isSilentLevel(db);
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-label="Nível de áudio"
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={typeof db === "number" ? Math.round(db) : undefined}
        aria-valuetext={typeof db === "number" ? `${Math.round(db)} dBFS` : "sem leitura"}
        className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={`h-full rounded-full ${silent ? "bg-red-fg" : "bg-ok-fg"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-16 text-right text-xs tabular-nums text-muted">
        {typeof db === "number" ? `${Math.round(db)} dB` : "—"}
      </span>
    </div>
  );
}

function MachineCard({
  machine: m,
  agents,
  debates,
  defaultDebateSlug,
  now,
  silentSince,
  onSaveDesired,
}: MachinesPanelProps & { machine: CaptureMachine; silentSince: number | null }) {
  const online = machineOnline(m, now);
  const active = isActiveMachine(m, agents);
  const r = m.reported;
  const warnings = machineWarnings(m, agents, now, silentSince);
  const lastSeg = secondsSince(r.last_segment_at ?? null, now);

  return (
    <article className={`rounded-xl border p-3 ${warnings.some((w) => w.tone === "bad") ? "border-red-border" : "border-border"} bg-bg`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{m.name}</h3>
        <Pill tone={online ? "ok" : "bad"}>{online ? "● online" : "○ offline"}</Pill>
        {active ? <Pill tone="ok">agente ativo</Pill> : null}
        <Pill tone={r.state === "error" ? "bad" : r.state === "running" ? "ok" : "neutral"}>
          {r.state ? REPORTED_TEXT[r.state] : "sem relato"}
        </Pill>
        <span className="ml-auto text-xs text-muted">
          {m.platform ?? "?"} · v{m.version ?? "?"}
        </span>
      </header>

      {warnings.length ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {warnings.map((w, i) => (
            <li
              key={i}
              role="alert"
              className={`rounded-lg border px-2.5 py-1.5 text-sm font-medium ${
                w.tone === "bad" ? "border-red-border bg-red-bg text-red-fg" : "border-yellow-border bg-yellow-bg text-yellow-fg"
              }`}
            >
              {w.text}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3">
        <AudioMeter db={r.audio_level_db} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted">Último contato</dt>
          <dd className="tabular-nums">{m.last_seen ? `há ${formatDuration(secondsSince(m.last_seen, now))}` : "nunca"}</dd>
        </div>
        <div>
          <dt className="text-muted">Último segmento</dt>
          <dd className="tabular-nums">{lastSeg === null ? "—" : `há ${formatDuration(lastSeg)}`}</dd>
        </div>
        <div>
          <dt className="text-muted">Segmentos</dt>
          <dd className="tabular-nums">{r.segments_sent ?? 0}</dd>
        </div>
        <div>
          <dt className="text-muted">Reconexões</dt>
          <dd className="tabular-nums">{r.reconnects ?? 0}</dd>
        </div>
        <div className="col-span-2 sm:col-span-4">
          <dt className="text-muted">Desejado</dt>
          <dd>
            {describeDesired(m.desired)}{" "}
            <span className="text-muted">(definido às {formatTimeSec(m.desired_updated_at)})</span>
          </dd>
        </div>
      </dl>

      {r.log_tail?.length ? (
        <details className="mt-2 rounded-lg border border-border text-xs">
          <summary className="cursor-pointer px-2.5 py-1.5 text-muted">Log recente ({r.log_tail.length} linhas)</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-2.5 pb-2 font-mono">{r.log_tail.join("\n")}</pre>
        </details>
      ) : null}

      <DesiredForm machine={m} debates={debates} defaultDebateSlug={defaultDebateSlug} onSaveDesired={onSaveDesired} />
    </article>
  );
}

function DesiredForm({
  machine: m,
  debates,
  defaultDebateSlug,
  onSaveDesired,
}: Pick<MachinesPanelProps, "debates" | "defaultDebateSlug" | "onSaveDesired"> & { machine: CaptureMachine }) {
  const d = m.desired;
  const [slug, setSlug] = useState(d.debate_slug ?? defaultDebateSlug ?? debates[0]?.slug ?? "");
  const debate = debates.find((x) => x.slug === slug) ?? null;
  const [source, setSource] = useState<NonNullable<MachineDesired["source"]>>(d.source ?? "youtube");
  const [url, setUrl] = useState(d.url ?? debate?.youtube_url ?? "");
  const [device, setDevice] = useState(d.device ?? "");
  const [role, setRole] = useState<NonNullable<MachineDesired["role"]>>(d.role ?? "primary");
  const [startAt, setStartAt] = useState(isoToLocalInput(d.start_at ?? suggestStartAt(debate?.scheduled_at)));
  const [stopAt, setStopAt] = useState(isoToLocalInput(d.stop_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const idp = `m-${m.id}`;
  const suggestion = suggestStartAt(debate?.scheduled_at);

  function config(): Omit<MachineDesired, "state"> {
    const c: Omit<MachineDesired, "state"> = { debate_slug: slug || undefined, source, role };
    if (source === "device") c.device = device.trim() || undefined;
    else c.url = url.trim() || undefined;
    const stop = localInputToIso(stopAt);
    if (stop) c.stop_at = stop;
    return c;
  }

  async function save(desired: MachineDesired, success: string) {
    const parsed = MachineDesiredSchema.safeParse(desired);
    if (!parsed.success) return setError(`Configuração inválida: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    if (desired.state === "running") {
      if (!desired.debate_slug) return setError("Escolha o debate.");
      if (desired.source === "device" ? !desired.device : !desired.url) {
        return setError(desired.source === "device" ? "Informe o dispositivo de áudio." : "Informe a URL ou o arquivo.");
      }
      const sourceError = desiredSourceError(desired);
      if (sourceError) return setError(sourceError);
    }
    setBusy(true);
    setError(null);
    setOk(null);
    const err = await onSaveDesired(m.id, parsed.data as MachineDesired);
    setBusy(false);
    if (err) setError(err);
    else setOk(success);
  }

  function startNow() {
    void save({ state: "running", ...config() }, "Comando enviado: iniciar agora. A máquina obedece no próximo contato (~3 s).");
  }

  function schedule() {
    const start = localInputToIso(startAt);
    if (!start) return setError("Defina o horário de início para agendar.");
    if (Date.parse(start) < Date.now()) return setError("O início agendado já passou — use “Iniciar agora”.");
    void save({ state: "running", ...config(), start_at: start }, `Agendado para ${startAt.replace("T", " ")}.`);
  }

  function stop() {
    const msg = `Parar a captura em "${m.name}"?${m.reported.active ? "\n\nEsta é a máquina ATIVA: o standby assume (se houver)." : ""}`;
    if (!window.confirm(msg)) return;
    const { stop_at: _ignored, ...rest } = config();
    void save({ state: "stopped", ...rest }, "Comando enviado: parar.");
  }

  return (
    <details className="mt-3 rounded-lg border border-border" open={m.desired.state === "stopped" && !m.last_seen ? true : undefined}>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Comandar esta máquina</summary>
      <div className="flex flex-col gap-3 border-t border-border p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Debate" htmlFor={`${idp}-debate`}>
            <select
              id={`${idp}-debate`}
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                const nd = debates.find((x) => x.slug === e.target.value);
                if (source === "youtube" && nd?.youtube_url) setUrl(nd.youtube_url);
                const sug = suggestStartAt(nd?.scheduled_at);
                if (sug) setStartAt(isoToLocalInput(sug));
              }}
              className={inputCls}
            >
              {debates.map((x) => (
                <option key={x.id} value={x.slug}>
                  {x.title} (/{x.slug})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Papel" htmlFor={`${idp}-role`} hint="Principal tem prioridade no failover; standby assume se o principal cair.">
            <select id={`${idp}-role`} value={role} onChange={(e) => setRole(e.target.value as typeof role)} className={inputCls}>
              <option value="primary">Principal (primary)</option>
              <option value="standby">Reserva (standby)</option>
            </select>
          </Field>
          <Field label="Fonte" htmlFor={`${idp}-source`}>
            <select
              id={`${idp}-source`}
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
              className={inputCls}
            >
              {(Object.keys(SOURCE_TEXT) as (keyof typeof SOURCE_TEXT)[]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_TEXT[s]}
                </option>
              ))}
            </select>
          </Field>
          {source === "device" ? (
            <Field label="Dispositivo de áudio" htmlFor={`${idp}-device`} hint="Nome como aparece no `capture doctor` (ex.: BlackHole 2ch, Stereo Mix).">
              <input id={`${idp}-device`} value={device} onChange={(e) => setDevice(e.target.value)} className={inputCls} />
            </Field>
          ) : (
            <Field label={source === "youtube" ? "URL da live" : "Caminho do arquivo"} htmlFor={`${idp}-url`}>
              <input
                id={`${idp}-url`}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className={inputCls}
                inputMode={source === "youtube" ? "url" : "text"}
                placeholder={source === "youtube" ? "https://www.youtube.com/watch?v=…" : "/caminho/debate.mp4"}
              />
            </Field>
          )}
          <Field
            label="Início (horário de Brasília)"
            htmlFor={`${idp}-start`}
            hint={
              suggestion ? (
                <button type="button" className="underline" onClick={() => setStartAt(isoToLocalInput(suggestion))}>
                  Usar sugestão: {START_LEAD_MIN} min antes do debate ({isoToLocalInput(suggestion).replace("T", " ")})
                </button>
              ) : (
                "Defina o horário previsto do debate para receber uma sugestão."
              )
            }
          >
            <input
              id={`${idp}-start`}
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Parar automaticamente às (opcional)" htmlFor={`${idp}-stop`} hint="Segurança contra esquecer a captura ligada.">
            <input id={`${idp}-stop`} type="datetime-local" value={stopAt} onChange={(e) => setStopAt(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Button variant="primary" onClick={startNow} disabled={busy}>
            ▶ Iniciar agora
          </Button>
          <Button onClick={schedule} disabled={busy}>
            ⏱ Agendar
          </Button>
          <Button variant="danger" onClick={stop} disabled={busy}>
            ■ Parar
          </Button>
        </div>
      </div>
    </details>
  );
}

function AgentsTable({ agents, now, failoverAfterS, onSetActive }: MachinesPanelProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function makeActive(a: CaptureAgent) {
    if (!window.confirm(`Tornar "${a.name}" o agente ativo? Os segmentos do agente atual passam a ser descartados.`)) return;
    setBusy(a.id);
    setError(null);
    const err = await onSetActive(a.id);
    setBusy(null);
    if (err) setError(err);
  }

  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold">Agentes do debate</h3>
      <p className="mb-2 text-xs text-muted">
        Só o agente ativo grava segmentos. Sem heartbeat por {failoverAfterS} s, o banco promove outro automaticamente.
      </p>
      <ErrorText>{error}</ErrorText>
      {agents.length === 0 ? (
        <p className="text-sm text-muted">Nenhum agente registrado neste debate.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((a) => {
            const age = secondsSince(a.last_heartbeat, now);
            const alive = age !== null && age < failoverAfterS;
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2.5 text-sm">
                <span className="font-medium">{a.name}</span>
                <Pill>{SOURCE_TEXT[a.source]}</Pill>
                <Pill>{a.role === "primary" ? "principal" : "standby"}</Pill>
                {a.active ? <Pill tone={alive ? "ok" : "bad"}>ativo</Pill> : null}
                <span className={`text-xs tabular-nums ${alive ? "text-muted" : "text-red-fg"}`}>
                  heartbeat {age === null ? "nunca" : `há ${formatDuration(age)}`}
                </span>
                {!a.active ? (
                  <Button className="ml-auto" onClick={() => void makeActive(a)} disabled={busy !== null}>
                    Tornar ativo
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
