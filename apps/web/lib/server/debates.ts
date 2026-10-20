import "server-only";
import { resolveSettings, type Debate } from "@actually/db";
import { cache } from "react";
import { attributionFrom, type Attribution } from "../feed";
import { publicServerClient } from "../supabase/server";

export type PublicDebate = Pick<Debate, "id" | "slug" | "title" | "status" | "youtube_url" | "scheduled_at" | "created_at">;

export type LoadResult<T> = { ok: true; data: T } | { ok: false; reason: "unconfigured" | "error"; message: string };

const FIELDS = "id, slug, title, status, youtube_url, scheduled_at, created_at";
const STATUS_ORDER = { live: 0, scheduled: 1, ended: 2 } as const;

/** Lista pública: ao vivo primeiro, depois agendados, depois encerrados. */
export async function listDebates(): Promise<LoadResult<PublicDebate[]>> {
  const db = publicServerClient();
  if (!db) return { ok: false, reason: "unconfigured", message: "Supabase não configurado" };
  // A RLS já esconde debate de teste do anônimo; o filtro explícito é defesa extra.
  const { data, error } = await db.from("debates").select(FIELDS).eq("is_test", false).order("created_at", { ascending: false }).limit(50);
  if (error) return { ok: false, reason: "error", message: error.message };
  const list = (data ?? []) as PublicDebate[];
  list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  return { ok: true, data: list };
}

/** Debate + atribuição inicial (settings + speaker_map). null = não existe. */
export const loadDebate = cache(
  async (slug: string): Promise<LoadResult<{ debate: PublicDebate; attribution: Attribution } | null>> => {
    const db = publicServerClient();
    if (!db) return { ok: false, reason: "unconfigured", message: "Supabase não configurado" };
    const { data, error } = await db.from("debates").select(`${FIELDS}, settings`).eq("slug", slug).eq("is_test", false).maybeSingle();
    if (error) return { ok: false, reason: "error", message: error.message };
    if (!data) return { ok: true, data: null };
    const row = data as PublicDebate & { settings: Debate["settings"] | null };
    const { data: speakers, error: spErr } = await db
      .from("speaker_map")
      .select("speaker_label, person")
      .eq("debate_id", row.id);
    if (spErr) return { ok: false, reason: "error", message: spErr.message };
    const { settings, ...debate } = row;
    return {
      ok: true,
      data: {
        debate,
        attribution: attributionFrom(resolveSettings(settings), (speakers ?? []) as { speaker_label: string; person: string }[]),
      },
    };
  },
);
