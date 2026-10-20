"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./ui";

/** Confirmação no próprio lugar do botão: nada é pedido ao servidor sem o segundo clique. */
export function ConfirmBox({ text, onConfirm, onCancel }: { text: ReactNode; onConfirm: () => void; onCancel: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div
      role="group"
      aria-label="Confirmar tarefa"
      className="flex flex-col gap-2 rounded-lg border border-yellow-border bg-yellow-bg p-3 text-sm text-fg"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div>{text}</div>
      <div className="flex flex-wrap gap-2">
        <Button ref={confirmRef} variant="primary" onClick={onConfirm}>
          Confirmar
        </Button>
        <Button onClick={onCancel}>Cancelar</Button>
      </div>
    </div>
  );
}
