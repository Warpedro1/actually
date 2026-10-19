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
  /** Segmento aceito e processado (pipeline rodou). */
  z.object({ status: z.literal("accepted"), segment_id: z.number(), alerts: z.number() }),
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
