"use client";

import type { Debate } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { isoToLocalInput, localInputToIso } from "@/lib/format";
import { youtubeVideoId } from "@/lib/youtube";
import { ConfirmBox } from "./ConfirmBox";
import { Button, Card, ErrorText, Field, inputCls, OkText, Pill, errMsg } from "./ui";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUS_TEXT = { scheduled: "Agendado", live: "Ao vivo", ended: "Encerrado" } as const;

function checkYoutube(url: string): string | null {
  if (!url.trim()) return null;
  return youtubeVideoId(url) ? null : "URL do YouTube não reconhecida (use o link do vídeo/live).";
}

/** Criar debate + editar o selecionado (título, URL, horário previsto, status). */
export function DebateForms({
  client,
  selected,
  onSaved,
  onCreated,
}: {
  client: SupabaseClient;
  selected: Debate | null;
  onSaved: () => Promise<void> | void;
  onCreated: (id: string) => void;
}) {
  return (
    <div id="debate" className="grid gap-4 lg:grid-cols-2">
      {selected ? <EditDebate key={selected.id} client={client} debate={selected} onSaved={onSaved} /> : null}
      <CreateDebate client={client} onCreated={onCreated} />
    </div>
  );
}

function EditDebate({ client, debate, onSaved }: { client: SupabaseClient; debate: Debate; onSaved: () => Promise<void> | void }) {
  const [title, setTitle] = useState(debate.title);
  const [youtube, setYoutube] = useState(debate.youtube_url ?? "");
  const [scheduled, setScheduled] = useState(isoToLocalInput(debate.scheduled_at));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [askVisibility, setAskVisibility] = useState(false);

  useEffect(() => {
    setTitle(debate.title);
    setYoutube(debate.youtube_url ?? "");
    setScheduled(isoToLocalInput(debate.scheduled_at));
  }, [debate]);

  async function update(patch: Partial<Debate>, success: string) {
    setBusy(true);
    setError(null);
    setOk(null);
    const { error: err } = await client.from("debates").update(patch).eq("id", debate.id);
    setBusy(false);
    if (err) return setError(errMsg(err));
    setOk(success);
    await onSaved();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const yt = checkYoutube(youtube);
    if (yt) return setError(yt);
    void update(
      { title: title.trim(), youtube_url: youtube.trim() || null, scheduled_at: localInputToIso(scheduled) },
      "Debate atualizado.",
    );
  }

  function setStatus(status: Debate["status"]) {
    if (status === debate.status) return;
    if (!window.confirm(`Mudar o status para "${STATUS_TEXT[status]}"?`)) return;
    const patch: Partial<Debate> = { status };
    if (status === "live" && !debate.started_at) patch.started_at = new Date().toISOString();
    if (status === "ended") patch.ended_at = new Date().toISOString();
    void update(patch, `Status: ${STATUS_TEXT[status]}.`);
  }

  const visibility = debate.is_test ? (
    <>
      <p>
        Tornar “{debate.title}” <strong>público</strong>? Ele passa a aparecer na página inicial e em /ao-vivo/{debate.slug}.
      </p>
      <p className="mt-1 text-xs">
        Os vereditos dele passam a ser reaproveitados por outros debates (inclusive o oficial). Faça isso só com o debate oficial ou um
        ensaio já revisado.
      </p>
    </>
  ) : (
    <>
      <p>
        Marcar “{debate.title}” como <strong>teste</strong>? Ele some da página inicial e o link /ao-vivo/{debate.slug} passa a dar “não
        encontrado” para o público.
      </p>
      <p className="mt-1 text-xs">
        Os vereditos dele deixam de ser reaproveitados por outros debates (o que já foi reaproveitado fica).
        {debate.status === "live" ? " Atenção: este debate está AO VIVO — quem estiver assistindo para de receber alertas." : ""}
      </p>
    </>
  );

  return (
    <Card title={`Debate /${debate.slug}`}>
      <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Pill tone={debate.is_test ? "warn" : "ok"}>{debate.is_test ? "Teste — só editores veem" : "Público"}</Pill>
          <span className="flex flex-wrap gap-3 text-sm">
            <Link href={`/admin/previa/${debate.slug}`} className="underline">
              Prévia (como o público vê)
            </Link>
            {!debate.is_test ? (
              <Link href={`/ao-vivo/${debate.slug}`} className="underline">
                Abrir /ao-vivo/{debate.slug}
              </Link>
            ) : null}
          </span>
        </div>
        <p className="text-xs text-muted">
          {debate.is_test
            ? "Debate de teste: fora da página inicial, link público dá “não encontrado”, e os vereditos dele não valem para outros debates."
            : "Debate público: aparece na página inicial e os vereditos dele podem ser reaproveitados por outros debates."}
        </p>
        {askVisibility ? (
          <ConfirmBox
            text={visibility}
            onCancel={() => setAskVisibility(false)}
            onConfirm={() => {
              setAskVisibility(false);
              void update(
                { is_test: !debate.is_test },
                debate.is_test ? "Debate agora é público." : "Debate marcado como teste: só editores veem.",
              );
            }}
          />
        ) : (
          <div>
            <Button disabled={busy} onClick={() => setAskVisibility(true)}>
              {debate.is_test ? "Tornar público" : "Marcar como teste"}
            </Button>
          </div>
        )}
      </div>
      <div role="group" aria-label="Status" className="mb-4 grid grid-cols-3 gap-2">
        {(Object.keys(STATUS_TEXT) as Debate["status"][]).map((s) => (
          <Button
            key={s}
            variant={debate.status === s ? "primary" : "secondary"}
            aria-pressed={debate.status === s}
            onClick={() => setStatus(s)}
            disabled={busy}
          >
            {STATUS_TEXT[s]}
          </Button>
        ))}
      </div>
      <form onSubmit={save} className="flex flex-col gap-3">
        <Field label="Título" htmlFor="ed-title">
          <input id="ed-title" required value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
        </Field>
        <Field label="URL do YouTube" htmlFor="ed-yt" hint="Usada no player da página pública e como fonte padrão das máquinas.">
          <input id="ed-yt" inputMode="url" value={youtube} onChange={(e) => setYoutube(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Início previsto (Brasília)" htmlFor="ed-sched" hint="Base da sugestão de início da captura (15 min antes).">
          <input id="ed-sched" type="datetime-local" value={scheduled} onChange={(e) => setScheduled(e.target.value)} className={inputCls} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
        <Button type="submit" variant="primary" disabled={busy}>
          Salvar debate
        </Button>
      </form>
    </Card>
  );
}

function CreateDebate({ client, onCreated }: { client: SupabaseClient; onCreated: (id: string) => void }) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [youtube, setYoutube] = useState("");
  const [scheduled, setScheduled] = useState("");
  // Até o debate oficial quase tudo é ensaio: nasce como teste (só editores veem, vereditos isolados).
  const [isTest, setIsTest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!SLUG_RE.test(slug)) return setError("Slug: só letras minúsculas, números e hífens (ex.: debate-23-10).");
    const yt = checkYoutube(youtube);
    if (yt) return setError(yt);
    setBusy(true);
    setError(null);
    const { data, error: err } = await client
      .from("debates")
      .insert({ slug, title: title.trim(), youtube_url: youtube.trim() || null, scheduled_at: localInputToIso(scheduled), is_test: isTest })
      .select("id")
      .single();
    setBusy(false);
    if (err) return setError(err.code === "23505" ? "Já existe um debate com esse slug." : errMsg(err));
    setOk(isTest ? `Criado como teste: prévia em /admin/previa/${slug}` : `Criado e público: /ao-vivo/${slug}`);
    setSlug("");
    setTitle("");
    setYoutube("");
    setScheduled("");
    onCreated((data as { id: string }).id);
  }

  return (
    <Card title="Novo debate">
      <form onSubmit={create} className="flex flex-col gap-3">
        <Field label="Slug (endereço)" htmlFor="new-slug" hint={slug ? `Página: /ao-vivo/${slug}` : "Ex.: debate-23-10"}>
          <input
            id="new-slug"
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            className={inputCls}
          />
        </Field>
        <Field label="Título" htmlFor="new-title">
          <input id="new-title" required value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
        </Field>
        <Field label="URL do YouTube (opcional)" htmlFor="new-yt">
          <input id="new-yt" inputMode="url" value={youtube} onChange={(e) => setYoutube(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Início previsto (Brasília, opcional)" htmlFor="new-sched">
          <input id="new-sched" type="datetime-local" value={scheduled} onChange={(e) => setScheduled(e.target.value)} className={inputCls} />
        </Field>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} />
          <span>
            <strong>Debate de teste</strong> (ensaio)
            <span className="block text-xs text-muted">
              Só editores veem (fora da página inicial; o link público dá “não encontrado”) e os vereditos dele não são reaproveitados por
              outros debates. Desmarque só para o debate oficial. Dá para trocar depois.
            </span>
          </span>
        </label>
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
        <Button type="submit" variant="primary" disabled={busy}>
          Criar debate
        </Button>
      </form>
    </Card>
  );
}
