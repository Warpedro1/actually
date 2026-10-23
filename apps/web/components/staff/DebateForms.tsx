"use client";

import type { CheckMode, Debate } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { CHECK_MODE_TEXT, STATUS_TEXT, StatusBadge } from "@/components/StatusBadge";
import { isoToLocalInput, localInputToIso } from "@/lib/format";
import { youtubeVideoId } from "@/lib/youtube";
import { ConfirmBox } from "./ConfirmBox";
import { Modal } from "./Modal";
import { Button, Card, ErrorText, Field, inputCls, OkText, Pill, errMsg } from "./ui";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Mesmo limite do `check` em `debates.public_note` (migration 20261023000016). */
export const PUBLIC_NOTE_MAX = 500;

/**
 * Procedência da checagem: declaração do editor, porque não dá para derivar dos
 * horários (ver a migration). Vazio = não informado, e a página pública não
 * afirma nada.
 */
const CHECK_MODES: (CheckMode | "")[] = ["", "live", "post", "mixed"];
const checkModeLabel = (m: CheckMode | "") => (m === "" ? "Não informado (a página não mostra nada)" : CHECK_MODE_TEXT[m]);

function PublicNoteField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field
      label="Observação pública (opcional)"
      htmlFor={id}
      hint={`Aparece para quem abre a página do debate, acima dos alertas. ${value.length}/${PUBLIC_NOTE_MAX} caracteres.`}
    >
      <textarea
        id={id}
        rows={3}
        maxLength={PUBLIC_NOTE_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} min-h-20 resize-y`}
      />
    </Field>
  );
}

function CheckModeField({ id, value, onChange }: { id: string; value: CheckMode | ""; onChange: (v: CheckMode | "") => void }) {
  return (
    <Field
      label="Procedência da checagem"
      htmlFor={id}
      hint="Mostrado ao lado do status, na página pública. Checagem feita depois do debate tem mais fonte disponível, então o público precisa saber qual foi o caso."
    >
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as CheckMode | "")} className={inputCls}>
        {CHECK_MODES.map((m) => (
          <option key={m} value={m}>
            {checkModeLabel(m)}
          </option>
        ))}
      </select>
    </Field>
  );
}

function checkYoutube(url: string): string | null {
  if (!url.trim()) return null;
  return youtubeVideoId(url) ? null : "URL do YouTube não reconhecida (use o link do vídeo/live).";
}

/** Criar debate (em diálogo) + editar o selecionado (título, URL, horário, status, aviso). */
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
  const [creating, setCreating] = useState(false);
  // O diálogo fecha ao criar, então o aviso de sucesso aparece aqui fora.
  const [created, setCreated] = useState<string | null>(null);

  return (
    <div id="debate" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {selected ? `Editando /${selected.slug}.` : "Nenhum debate selecionado — escolha um acima ou crie um novo."}
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setCreated(null);
            setCreating(true);
          }}
        >
          Novo debate
        </Button>
      </div>
      <OkText>{created}</OkText>
      {selected ? <EditDebate key={selected.id} client={client} debate={selected} onSaved={onSaved} /> : null}
      <Modal title="Novo debate" open={creating} onClose={() => setCreating(false)}>
        <CreateDebate
          client={client}
          onCreated={(id, message) => {
            setCreating(false);
            setCreated(message);
            onCreated(id);
          }}
        />
      </Modal>
    </div>
  );
}

function EditDebate({ client, debate, onSaved }: { client: SupabaseClient; debate: Debate; onSaved: () => Promise<void> | void }) {
  const [title, setTitle] = useState(debate.title);
  const [youtube, setYoutube] = useState(debate.youtube_url ?? "");
  const [scheduled, setScheduled] = useState(isoToLocalInput(debate.scheduled_at));
  const [note, setNote] = useState(debate.public_note ?? "");
  const [checkMode, setCheckMode] = useState<CheckMode | "">(debate.check_mode ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [askVisibility, setAskVisibility] = useState(false);

  useEffect(() => {
    setTitle(debate.title);
    setYoutube(debate.youtube_url ?? "");
    setScheduled(isoToLocalInput(debate.scheduled_at));
    setNote(debate.public_note ?? "");
    setCheckMode(debate.check_mode ?? "");
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
      {
        title: title.trim(),
        youtube_url: youtube.trim() || null,
        scheduled_at: localInputToIso(scheduled),
        public_note: note.trim() || null,
        check_mode: checkMode || null,
      },
      "Debate atualizado.",
    );
  }

  function setStatus(status: Debate["status"]) {
    if (status === debate.status) return;
    if (!window.confirm(`Mudar o status para "${STATUS_TEXT[status]}"?`)) return;
    const patch: Partial<Debate> = { status };
    if (status === "live" && !debate.started_at) patch.started_at = new Date().toISOString();
    // Só a primeira vez: reabrir e encerrar de novo não deve mover o fim do debate.
    if (status === "ended" && !debate.ended_at) patch.ended_at = new Date().toISOString();
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
          <span className="flex flex-wrap items-center gap-2">
            {/* mesmo selo que o público vê */}
            <StatusBadge status={debate.status} />
            <Pill tone={debate.is_test ? "warn" : "ok"}>{debate.is_test ? "Teste — só editores veem" : "Público"}</Pill>
          </span>
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
        <CheckModeField id="ed-mode" value={checkMode} onChange={setCheckMode} />
        <PublicNoteField id="ed-note" value={note} onChange={setNote} />
        <ErrorText>{error}</ErrorText>
        <OkText>{ok}</OkText>
        <Button type="submit" variant="primary" disabled={busy}>
          Salvar debate
        </Button>
      </form>
    </Card>
  );
}

function CreateDebate({ client, onCreated }: { client: SupabaseClient; onCreated: (id: string, message: string) => void }) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [youtube, setYoutube] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [note, setNote] = useState("");
  const [checkMode, setCheckMode] = useState<CheckMode | "">("");
  // Até o debate oficial quase tudo é ensaio: nasce como teste (só editores veem, vereditos isolados).
  const [isTest, setIsTest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!SLUG_RE.test(slug)) return setError("Slug: só letras minúsculas, números e hífens (ex.: debate-23-10).");
    const yt = checkYoutube(youtube);
    if (yt) return setError(yt);
    setBusy(true);
    setError(null);
    const { data, error: err } = await client
      .from("debates")
      .insert({
        slug,
        title: title.trim(),
        youtube_url: youtube.trim() || null,
        scheduled_at: localInputToIso(scheduled),
        public_note: note.trim() || null,
        check_mode: checkMode || null,
        is_test: isTest,
      })
      .select("id")
      .single();
    setBusy(false);
    if (err) return setError(err.code === "23505" ? "Já existe um debate com esse slug." : errMsg(err));
    const message = isTest ? `Criado como teste: prévia em /admin/previa/${slug}` : `Criado e público: /ao-vivo/${slug}`;
    setSlug("");
    setTitle("");
    setYoutube("");
    setScheduled("");
    setNote("");
    setCheckMode("");
    onCreated((data as { id: string }).id, message);
  }

  return (
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
        <CheckModeField id="new-mode" value={checkMode} onChange={setCheckMode} />
        <PublicNoteField id="new-note" value={note} onChange={setNote} />
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
      <Button type="submit" variant="primary" disabled={busy}>
        Criar debate
      </Button>
    </form>
  );
}
