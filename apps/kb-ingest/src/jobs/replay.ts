// Reprocessamento da transcrição: copia os trechos de fala de um debate para um debate
// de teste novo e roda o pipeline em cada um, na ordem da fala. Não há áudio nem
// transcrição nova — o texto é o mesmo da rodada original, então a diferença no
// resultado vem da extração, da verificação e da base.
//
// - O captured_at da origem é deslocado em bloco (shift_ms): a janela de contexto do
//   pipeline (os 60 s anteriores) vê os mesmos trechos vizinhos do original. Por isso a
//   latência medida no debate novo não se compara com a do ao vivo.
// - Idempotente: se a função cair, o executor repete a etapa; trecho já copiado (mesmo
//   agente e seq) é pulado sem rodar o pipeline de novo.
// - Falha num trecho (gravação ou pipeline) conta e segue; erro ao ler a origem para a etapa.
import { requireDb, type Ctx } from "../lib/ctx";
import type { KbStep, ReplayStep, StepEnv } from "./steps";

/** Trechos da origem lidos por consulta. */
const PAGE = 50;

interface SourceSegment {
  id: number | string;
  agent_id: string;
  seq: number;
  speaker_label: string | null;
  text: string;
  t_start: number | string;
  t_end: number | string;
  captured_at: string;
}

export async function runReplay(ctx: Ctx, step: ReplayStep, env: StepEnv): Promise<KbStep[]> {
  const runSegment = env.runSegment;
  if (!runSegment) throw new Error("o reprocessamento só roda no servidor do site (precisa do pipeline)");
  const db = requireDb(ctx);
  const now = env.now ?? Date.now;
  const queue = [...step.ids];
  const first = step.done + 1;
  let done = step.done;
  let claims = 0;
  let alerts = 0;
  let failed = 0;
  let skipped = 0;

  while (queue.length && now() < env.deadline) {
    const page = queue.slice(0, PAGE);
    const { data, error } = await db.from("segments").select("*").in("id", page);
    if (error) throw new Error(`segments: ${error.message}`);
    const byId = new Map(((data ?? []) as SourceSegment[]).map((s) => [Number(s.id), s]));

    for (const id of page) {
      if (now() >= env.deadline) break;
      queue.shift();
      done++;
      const src = byId.get(id);
      const agent = src ? step.agents[src.agent_id] : undefined;
      if (!src || !agent) {
        ctx.warn(`trecho ${id} não está mais na origem; pulei`);
        skipped++;
        continue;
      }
      const copied = await db.from("segments").select("id").eq("agent_id", agent).eq("seq", src.seq).maybeSingle();
      if (copied.error) throw new Error(`segments: ${copied.error.message}`);
      if (copied.data) {
        skipped++;
        continue;
      }
      const { data: row, error: insErr } = await db
        .from("segments")
        .insert({
          debate_id: step.target_debate_id,
          agent_id: agent,
          seq: src.seq,
          speaker_label: src.speaker_label,
          text: src.text,
          t_start: src.t_start,
          t_end: src.t_end,
          captured_at: new Date(Date.parse(src.captured_at) + step.shift_ms).toISOString(),
        })
        .select("id")
        .single();
      if (insErr || !row) {
        ctx.warn(`trecho ${id}: falha ao gravar a cópia — ${insErr?.message ?? "sem id"}`);
        failed++;
        continue;
      }
      try {
        const r = await runSegment((row as { id: number | string }).id);
        claims += r.claims;
        alerts += r.alerts;
      } catch (e) {
        ctx.warn(`trecho ${id}: pipeline falhou — ${e instanceof Error ? e.message : String(e)}`);
        failed++;
      }
    }
  }

  const extra = [failed ? `${failed} com falha` : "", skipped ? `${skipped} pulados (já copiados)` : ""].filter(Boolean);
  ctx.log(
    `trechos ${first}–${done} de ${step.total}: ${claims} afirmações, ${alerts} alertas` + (extra.length ? `; ${extra.join(", ")}` : ""),
  );
  return queue.length ? [{ ...step, ids: queue, done }] : [];
}
