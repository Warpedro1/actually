"use client";

// Reprocessar a transcrição de um debate num debate de teste novo (POST /api/kb/replay).
// Sem áudio nem transcrição nova: o mesmo texto passa de novo pelo pipeline atual,
// na fila da aba Base de conhecimento.

import type { Debate, ReplayCreated, ReplayPass } from "@actually/db";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { staffFetch } from "@/lib/staff/fetch";
import { defaultPassIds, passLabel } from "@/lib/staff/replay";
import { Button, ErrorText, errMsg } from "./ui";

export function ReplayDialog({
  client,
  debate,
  onCancel,
  onCreated,
}: {
  client: SupabaseClient;
  debate: Debate;
  onCancel: () => void;
  onCreated: (r: ReplayCreated) => void;
}) {
  const [passes, setPasses] = useState<ReplayPass[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    staffFetch<{ passes: ReplayPass[] }>(client, `/api/kb/replay?debate=${debate.id}`)
      .then(({ passes: list }) => {
        if (!alive) return;
        setPasses(list);
        setChosen(defaultPassIds(list));
      })
      .catch((e) => alive && setError(errMsg(e)));
    return () => {
      alive = false;
    };
  }, [client, debate.id]);

  const total = (passes ?? []).filter((p) => chosen.includes(p.agent_id)).reduce((n, p) => n + p.segments, 0);
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  async function start() {
    setBusy(true);
    setError(null);
    try {
      onCreated(
        await staffFetch<ReplayCreated>(client, "/api/kb/replay", {
          method: "POST",
          body: JSON.stringify({ debate_id: debate.id, agent_ids: chosen }),
        }),
      );
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        Cria um <strong>debate de teste novo</strong> e passa de novo, pelo pipeline de hoje, os trechos já transcritos de “{debate.title}”.
        Não usa áudio nem transcrição nova: o texto é o mesmo, então a diferença para a rodada original vem da extração, da verificação e
        da base.
      </p>
      {passes === null && !error ? <p className="text-muted">Carregando as passadas da captura…</p> : null}
      {passes && !passes.length ? <p className="text-muted">Este debate não tem trechos de fala gravados.</p> : null}
      {passes && passes.length ? (
        <fieldset className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 font-medium">Passadas da captura</legend>
          {passes.map((p) => (
            <label key={p.agent_id} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={chosen.includes(p.agent_id)} onChange={() => toggle(p.agent_id)} />
              <span>{passLabel(p)}</span>
            </label>
          ))}
          {passes.length > 1 ? (
            <p className="text-xs text-muted">
              Cada passada é uma vez que a captura rodou. Se o mesmo arquivo rodou mais de uma vez, marque só uma: as outras repetem o
              mesmo trecho. Marque mais de uma só se forem partes diferentes do debate (por exemplo, a máquina reserva assumiu).
            </p>
          ) : null}
        </fieldset>
      ) : null}
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
        <li>O debate novo nasce como teste (só editores veem), com as mesmas configurações e o mesmo mapa de vozes deste — que vale desde o primeiro trecho.</li>
        <li>
          Os trechos são processados um de cada vez, na ordem da fala, na fila da aba Base de conhecimento: a tarefa espera o que estiver na
          frente (por exemplo, “Embeddings faltando”). Leva mais ou menos o tempo da gravação.
        </li>
        <li>Custa o mesmo que uma rodada normal das APIs de modelo e de busca; o Deepgram não é usado.</li>
        <li>A latência medida no debate novo não se compara com a do ao vivo. Vereditos de debates públicos podem ser reaproveitados, como ao vivo.</li>
      </ul>
      <ErrorText>{error}</ErrorText>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button variant="primary" onClick={() => void start()} disabled={busy || !chosen.length || !total}>
          {busy ? "Criando…" : `Reprocessar ${total} trechos`}
        </Button>
      </div>
    </div>
  );
}
