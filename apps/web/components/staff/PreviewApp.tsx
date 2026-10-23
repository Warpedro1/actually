"use client";

import { resolveSettings, type Debate } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { LiveDebate } from "@/components/live/LiveDebate";
import { attributionFrom, type Attribution } from "@/lib/feed";
import type { LivePreview } from "@/lib/live/types";
import { ErrorText, errMsg } from "./ui";

type Loaded = { debate: Debate; attribution: Attribution } | null | "missing";

/**
 * /admin/previa/[slug]: o /ao-vivo como o público vê, mas com a sessão do
 * editor — funciona também para debate de teste, que a RLS esconde do público.
 */
export function PreviewApp({ client, slug }: { client: SupabaseClient; slug: string }) {
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo<LivePreview>(
    () => ({ client, token: async () => (await client.auth.getSession()).data.session?.access_token ?? null }),
    [client],
  );

  useEffect(() => {
    let off = false;
    void (async () => {
      const { data, error: err } = await client.from("debates").select("*").eq("slug", slug).maybeSingle<Debate>();
      if (off) return;
      if (err) return setError(errMsg(err));
      if (!data) return setLoaded("missing");
      const { data: speakers, error: spErr } = await client.from("speaker_map").select("speaker_label, person").eq("debate_id", data.id);
      if (off) return;
      if (spErr) return setError(errMsg(spErr));
      setLoaded({
        debate: data,
        attribution: attributionFrom(resolveSettings(data.settings), (speakers ?? []) as { speaker_label: string; person: string }[]),
      });
    })();
    return () => {
      off = true;
    };
  }, [client, slug]);

  if (error) return <div className="mx-auto max-w-3xl px-4 py-6"><ErrorText>{error}</ErrorText></div>;
  if (loaded === null) return <p className="mx-auto max-w-3xl px-4 py-6 text-sm text-muted">Carregando…</p>;
  if (loaded === "missing") return <div className="mx-auto max-w-3xl px-4 py-6"><ErrorText>Debate “{slug}” não encontrado.</ErrorText></div>;

  const { debate, attribution } = loaded;
  return (
    <>
      <div
        role="note"
        className={`border-b px-4 py-2 text-center text-sm ${debate.is_test ? "border-yellow-border bg-yellow-bg text-yellow-fg" : "border-border bg-surface-2 text-muted"}`}
      >
        {debate.is_test ? (
          <>
            <strong>Debate de teste</strong> — visível só para editores. Não é o debate oficial.
          </>
        ) : (
          <>
            Prévia do editor. Este debate é público em{" "}
            <Link href={`/ao-vivo/${debate.slug}`} className="underline">
              /ao-vivo/{debate.slug}
            </Link>
            .
          </>
        )}{" "}
        <Link href="/admin#debate" className="underline">
          Voltar ao /admin
        </Link>
      </div>
      <LiveDebate
        debate={{
          id: debate.id,
          slug: debate.slug,
          title: debate.title,
          status: debate.status,
          check_mode: debate.check_mode,
          public_note: debate.public_note,
          youtube_url: debate.youtube_url,
        }}
        attribution={attribution}
        preview={preview}
      />
    </>
  );
}
