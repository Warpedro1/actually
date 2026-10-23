"use client";

// Diálogo modal das áreas restritas, no molde do aviso público
// (components/DisclaimerGate.tsx): papel e nome acessível, Escape e clique fora
// fecham, foco começa no primeiro campo. Largura cabe em 390 px (RNF10).

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "./ui";

/** Teclas que fecham o diálogo (Esc é o nome antigo, ainda usado por alguns teclados). */
export function closesModal(key: string): boolean {
  return key === "Escape" || key === "Esc";
}

/** O que recebe foco dentro do diálogo: o primeiro é onde o foco começa. */
const FOCUSABLE = "input:not([type=hidden]), select, textarea, button, [href]";

/**
 * Para onde o Tab deve pular para não sair do diálogo (`aria-modal` promete que
 * não sai). `index` é a posição do foco atual na lista, -1 quando o foco está no
 * próprio diálogo. Null = deixa o navegador seguir normalmente.
 */
export function trapTarget(count: number, index: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (shift) return index <= 0 ? count - 1 : null;
  return index === count - 1 ? 0 : null;
}

export function Modal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    // Sem foco dentro do diálogo o Escape não chegaria, e o teclado continuaria atrás.
    (box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current)?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/60 p-4 sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (closesModal(e.key)) return onClose();
          if (e.key !== "Tab") return;
          const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
            (el) => !el.hasAttribute("disabled"),
          );
          const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
          if (target === null) return;
          e.preventDefault();
          items[target]?.focus();
        }}
        className="my-auto w-full max-w-lg rounded-xl border border-border bg-surface p-4 shadow-xl"
      >
        <div className="mb-3 flex items-start justify-between gap-2">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <Button variant="ghost" aria-label="Fechar" onClick={onClose}>
            <span aria-hidden="true">✕</span>
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}
