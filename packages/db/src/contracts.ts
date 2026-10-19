// Contratos HTTP entre capture agent e a API na Vercel.
import { z } from "zod";

export const INGEST_TOKEN_HEADER = "x-ingest-token";

/** POST /api/ingest/register — capture agent se apresenta ao subir. */
export const RegisterAgentRequest = z.object({
  debate_slug: z.string().min(1),
  name: z.string().min(1).max(80),
  source: z.enum(["youtube", "device", "file"]),
  role: z.enum(["primary", "standby"]),
});
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequest>;

export const RegisterAgentResponse = z.object({
  agent_id: z.string().uuid(),
  debate_id: z.string().uuid(),
});
export type RegisterAgentResponse = z.infer<typeof RegisterAgentResponse>;

/** POST /api/ingest/heartbeat — a cada ~2 s. */
export const HeartbeatRequest = z.object({ agent_id: z.string().uuid() });
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({ active: z.boolean() });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

/** POST /api/ingest/segment — um trecho final da transcrição. */
export const SegmentRequest = z.object({
  agent_id: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  text: z.string().min(1).max(4000),
  speaker_label: z.string().max(32).nullable(),
  t_start: z.number().nonnegative(),
  t_end: z.number().nonnegative(),
  /** ISO-8601, relógio do agente quando a fala terminou. */
  captured_at: z.string().datetime(),
});
export type SegmentRequest = z.infer<typeof SegmentRequest>;

export const SegmentResponse = z.discriminatedUnion("status", [
  /** Segmento gravado; o pipeline roda em segundo plano (after()) para não travar a fila do agente. */
  z.object({ status: z.literal("accepted"), segment_id: z.number() }),
  /** Retry de um seq já recebido — idempotente. */
  z.object({ status: z.literal("duplicate") }),
  /** Agente não é o ativo (standby); segmento descartado. */
  z.object({ status: z.literal("standby") }),
]);
export type SegmentResponse = z.infer<typeof SegmentResponse>;

/** GET /api/alerts?debate=<slug>&since=<iso> — fallback com cache de CDN. */
export const AlertsQuery = z.object({
  debate: z.string().min(1),
  since: z.string().datetime().optional(),
});

// Controle remoto ------------------------------------------------------------

export const MachineDesiredSchema = z.object({
  state: z.enum(["running", "stopped"]),
  debate_slug: z.string().min(1).optional(),
  source: z.enum(["youtube", "device", "file"]).optional(),
  url: z.string().min(1).optional(),
  device: z.string().min(1).optional(),
  role: z.enum(["primary", "standby"]).optional(),
  start_at: z.string().datetime().optional(),
  stop_at: z.string().datetime().optional(),
});

export const MachineReportedSchema = z.object({
  state: z.enum(["idle", "waiting_start", "starting", "running", "stopping", "error"]),
  agent_id: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
  debate_slug: z.string().nullable().optional(),
  source: z.enum(["youtube", "device", "file"]).nullable().optional(),
  last_segment_at: z.string().datetime().nullable().optional(),
  segments_sent: z.number().int().nonnegative().optional(),
  audio_level_db: z.number().nullable().optional(),
  reconnects: z.number().int().nonnegative().optional(),
  error: z.string().max(2000).nullable().optional(),
  log_tail: z.array(z.string().max(500)).max(20).optional(),
});

/**
 * POST /api/control/poll — o daemon chama a cada ~3 s com x-ingest-token.
 * Faz upsert da máquina pelo nome, grava reported/last_seen e devolve o desejado.
 */
export const ControlPollRequest = z.object({
  machine_name: z.string().min(1).max(80),
  platform: z.string().max(40),
  version: z.string().max(40),
  reported: MachineReportedSchema,
});
export type ControlPollRequest = z.infer<typeof ControlPollRequest>;

export const ControlPollResponse = z.object({
  machine_id: z.string().uuid(),
  desired: MachineDesiredSchema,
  /** Hora do servidor (ISO) — o daemon compara start_at/stop_at com ela, não com o relógio local. */
  server_time: z.string().datetime(),
});
export type ControlPollResponse = z.infer<typeof ControlPollResponse>;
