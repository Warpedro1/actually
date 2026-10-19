"use client";

import type { Debate } from "@actually/db";
import { inputCls } from "./ui";

const STATUS = { live: "ao vivo", scheduled: "agendado", ended: "encerrado" } as const;

export function DebatePicker({
  debates,
  selected,
  onSelect,
}: {
  debates: Debate[];
  selected: Debate | null;
  onSelect: (id: string) => void;
}) {
  if (debates.length === 0) return <p className="text-sm text-muted">Nenhum debate cadastrado — crie um no Admin.</p>;
  return (
    <label className="flex flex-col gap-1 text-sm font-medium sm:flex-row sm:items-center sm:gap-2">
      Debate
      <select value={selected?.id ?? ""} onChange={(e) => onSelect(e.target.value)} className={`${inputCls} sm:w-auto`}>
        {debates.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title} ({STATUS[d.status]}) — /{d.slug}
          </option>
        ))}
      </select>
    </label>
  );
}
