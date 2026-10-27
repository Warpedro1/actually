import "server-only";
import type { Debate, KbLogLine, ReplayCreate, ReplayCreated, ReplayPass } from "@actually/db";
import type { ReplayStep } from "@actually/kb-ingest/jobs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { formatDateTime } from "@/lib/format";

// Reprocessar a transcrição de um debate num debate de teste novo, sem áudio: o site
// cria o debate (mesmas configurações e mapa de vozes), um agente de captura por
// passada escolhida e uma tarefa "reprocessar" na fila da carga da base. O executor
// da fila copia os trechos e roda o pipeline em cada um (apps/kb-ingest/src/jobs/replay.ts).

/** O PostgREST devolve no máximo 1000 linhas por pedido. */
const PAGE = 1000;
/** Mesmo limite do `check` em debates.public_note. */
const NOTE_MAX = 500;

/** Pedido que não dá para atender (vira 400 na rota). */
export class ReplayError extends Error {}

interface SegmentRef {
  id: number | string;
  agent_id: string;
  captured_at: string;
  t_start: number | string;
  t_end: number | string;
}

/** Trechos do debate na ordem da fala (captured_at, depois id), paginando. */
async function segmentRefs(db: SupabaseClient, debateId: string, agentIds?: string[]): Promise<SegmentRef[]> {
  const out: SegmentRef[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db.from("segments").select("id, agent_id, captured_at, t_start, t_end").eq("debate_id", debateId);
    if (agentIds) q = q.in("agent_id", agentIds);
    const { data, error } = await q
      .order("captured_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`segments: ${error.message}`);
    const rows = (data ?? []) as SegmentRef[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Passadas da captura com trechos neste debate, da mais antiga para a mais nova. */
export async function listPasses(db: SupabaseClient, debateId: string): Promise<ReplayPass[]> {
  const byAgent = new Map<string, { segments: number; t0: number; t1: number; first_at: string; last_at: string }>();
  for (const s of await segmentRefs(db, debateId)) {
    const cur = byAgent.get(s.agent_id);
    const t0 = Number(s.t_start);
    const t1 = Number(s.t_end);
    if (!cur) {
      byAgent.set(s.agent_id, { segments: 1, t0, t1, first_at: s.captured_at, last_at: s.captured_at });
      continue;
    }
    cur.segments++;
    cur.t0 = Math.min(cur.t0, t0);
    cur.t1 = Math.max(cur.t1, t1);
    cur.last_at = s.captured_at;
  }
  if (!byAgent.size) return [];
  const { data, error } = await db.from("capture_agents").select("id, name").in("id", [...byAgent.keys()]);
  if (error) throw new Error(`capture_agents: ${error.message}`);
  const names = new Map(((data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]));
  return [...byAgent.entries()]
    .map(([agent_id, p]) => ({
      agent_id,
      name: names.get(agent_id) ?? "captura",
      segments: p.segments,
      duration_s: Math.max(0, Math.round(p.t1 - p.t0)),
      first_at: p.first_at,
      last_at: p.last_at,
    }))
    .sort((a, b) => Date.parse(a.first_at) - Date.parse(b.first_at));
}

/** "20261027-153005" no horário de Brasília (sufixo do slug do debate novo). */
export function brasiliaStamp(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const p = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? "00";
  return `${p("year")}${p("month")}${p("day")}-${p("hour")}${p("minute")}${p("second")}`;
}

function insertError(table: string, error: { message: string } | null): Error {
  return new Error(`${table}: ${error?.message ?? "sem retorno"}`);
}

/**
 * Cria o debate de teste, os agentes, a cópia do mapa de vozes e a tarefa. Sem transação:
 * se algo falhar no meio, sobra um debate de teste sem tarefa (só editores veem).
 */
export async function createReplay(
  db: SupabaseClient,
  req: ReplayCreate,
  createdBy: string | null,
  now = new Date(),
): Promise<ReplayCreated> {
  const { data: src, error: srcErr } = await db.from("debates").select("*").eq("id", req.debate_id).maybeSingle<Debate>();
  if (srcErr) throw new Error(`debates: ${srcErr.message}`);
  if (!src) throw new ReplayError("debate não encontrado");

  const agentIds = [...new Set(req.agent_ids)];
  const segs = await segmentRefs(db, src.id, agentIds);
  const found = new Set(segs.map((s) => s.agent_id));
  const missing = agentIds.filter((a) => !found.has(a));
  if (missing.length) throw new ReplayError(`passada sem trechos neste debate: ${missing.join(", ")}`);

  const { data: agents, error: agErr } = await db.from("capture_agents").select("id, name, role").in("id", agentIds);
  if (agErr) throw new Error(`capture_agents: ${agErr.message}`);

  // o último trecho fica no horário do pedido; os outros, antes dele, com o espaçamento original
  const last = Math.max(...segs.map((s) => Date.parse(s.captured_at)));
  const slug = `${src.slug}-reproc-${brasiliaStamp(now)}`;
  const title = `${src.title} — reprocessamento ${formatDateTime(now.toISOString())}`;
  const note = `Reprocessamento da transcrição de “${src.title.slice(0, 200)}” (${segs.length} trechos), para avaliação. Não é checagem ao vivo.`;
  const { data: created, error: dbErr } = await db
    .from("debates")
    .insert({
      slug,
      title,
      youtube_url: src.youtube_url,
      status: "ended",
      settings: src.settings,
      is_test: true,
      check_mode: "post",
      public_note: note.slice(0, NOTE_MAX),
    })
    .select("id")
    .single<{ id: string }>();
  if (dbErr || !created) throw insertError("debates", dbErr);

  const map: Record<string, string> = {};
  for (const a of (agents ?? []) as { id: string; name: string; role: string }[]) {
    const { data: row, error } = await db
      .from("capture_agents")
      .insert({ debate_id: created.id, name: `reprocessamento: ${a.name}`, source: "file", role: a.role, active: false })
      .select("id")
      .single<{ id: string }>();
    if (error || !row) throw insertError("capture_agents", error);
    map[a.id] = row.id;
  }

  const { data: speakers, error: spErr } = await db
    .from("speaker_map")
    .select("speaker_label, person, confirmed_by")
    .eq("debate_id", src.id);
  if (spErr) throw new Error(`speaker_map: ${spErr.message}`);
  const people = (speakers ?? []) as { speaker_label: string; person: string; confirmed_by: string | null }[];
  if (people.length) {
    const { error } = await db.from("speaker_map").insert(people.map((p) => ({ ...p, debate_id: created.id })));
    if (error) throw insertError("speaker_map", error);
  }

  const step: ReplayStep = {
    kind: "replay",
    target_debate_id: created.id,
    agents: map,
    ids: segs.map((s) => Number(s.id)),
    done: 0,
    total: segs.length,
    shift_ms: now.getTime() - last,
  };
  const log: KbLogLine[] = [
    {
      t: now.toISOString(),
      level: "info",
      msg: `pedida no /admin: ${segs.length} trechos de /${src.slug} → /${slug}, mapa de vozes com ${people.length} rótulos`,
    },
  ];
  const { data: job, error: jobErr } = await db
    .from("kb_jobs")
    .insert({
      preset: "reprocessar",
      title: `Reprocessar transcrição: ${src.title}`,
      params: { source_debate_id: src.id, source_slug: src.slug, target_debate_id: created.id, target_slug: slug, agent_ids: agentIds },
      steps: [step],
      log,
      created_by: createdBy,
    })
    .select("id")
    .single<{ id: string }>();
  if (jobErr || !job) throw insertError("kb_jobs", jobErr);

  return { job_id: job.id, debate: { id: created.id, slug, title }, segments: segs.length };
}
