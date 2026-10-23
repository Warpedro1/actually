// Selo de status do debate (agendado / ao vivo / encerrado) e procedência da
// checagem. Usado na página inicial e no topo do /ao-vivo — os dois precisam
// mostrar a mesma coisa do mesmo jeito.

import type { CheckMode } from "@actually/db";

export type DebateStatus = "scheduled" | "live" | "ended";

/** Status do debate em si (`debates.status`), não da checagem. */
export const STATUS_TEXT: Record<DebateStatus, string> = {
  scheduled: "Agendado",
  live: "Ao vivo",
  ended: "Encerrado",
};

const STATUS_CLS: Record<DebateStatus, string> = {
  scheduled: "border-border bg-surface text-muted",
  live: "border-red-border bg-red-bg text-red-fg",
  ended: "border-border bg-surface-2 text-fg",
};

/**
 * Procedência da checagem (`debates.check_mode`), declarada pelo editor: não dá
 * para derivar dos horários do debate (ver a migration 20261023000016 —
 * `started_at` fica nulo, `ended_at` é a hora do clique e, em replay de
 * arquivo, o relógio da captura é o do replay).
 * Nulo = não informado: a página não afirma nada.
 */
export const CHECK_MODE_TEXT: Record<CheckMode, string> = {
  live: "Checagem ao vivo",
  post: "Checado depois do debate",
  mixed: "Em parte ao vivo, em parte depois",
};

/**
 * Por que a diferença importa para quem lê: depois do debate as agências
 * publicam checagens, e elas entram na base. Checagem feita depois teve mais
 * fonte disponível do que teria quem assistiu ao vivo.
 */
export const CHECK_MODE_NOTE: Record<CheckMode, string | null> = {
  live: null,
  post: "Os alertas foram publicados depois da transmissão, com a base de fontes já maior: as checagens das agências publicadas no intervalo passaram a valer.",
  mixed: "Parte dos alertas saiu durante a transmissão; o resto depois, com a base de fontes já maior.",
};

export function StatusBadge({ status, className = "" }: { status: DebateStatus; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLS[status]} ${className}`}
    >
      {status === "live" ? <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-red-fg" /> : null}
      {STATUS_TEXT[status]}
    </span>
  );
}
