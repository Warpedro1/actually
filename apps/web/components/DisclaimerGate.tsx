"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DISCLAIMER_TEXT, DISCLAIMER_VERSION } from "@/lib/disclaimer";
import { STORAGE_KEYS, storageGet, storageSet } from "@/lib/storage";

/**
 * Aviso jurídico obrigatório. Na primeira visita, um modal bloqueia a página
 * até o aceite; depois fica um banner discreto e permanente.
 *
 * - O aceite é guardado em localStorage com versão. Se o storage falhar, o
 *   aceite vale só para esta página: na próxima visita o modal aparece de novo.
 * - No SSR o modal é sempre renderizado (nunca deixa passar sem aceite); o
 *   script do <head> o esconde por CSS antes da pintura para quem já aceitou.
 */
export function DisclaimerGate({ children }: { children: ReactNode }) {
  const [accepted, setAccepted] = useState(false);
  const [checked, setChecked] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setAccepted(storageGet(STORAGE_KEYS.disclaimer) === DISCLAIMER_VERSION);
    setChecked(true);
  }, []);

  const open = !accepted;

  useEffect(() => {
    if (!checked || !open) return;
    // Aviso não aceito: limpa marca antiga (versão anterior) e trava a rolagem.
    document.documentElement.removeAttribute("data-disclaimer");
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    buttonRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, [checked, open]);

  function accept() {
    storageSet(STORAGE_KEYS.disclaimer, DISCLAIMER_VERSION);
    document.documentElement.setAttribute("data-disclaimer", DISCLAIMER_VERSION);
    setAccepted(true);
  }

  return (
    <>
      <DisclaimerBanner />
      <div inert={open} className="contents">
        {children}
      </div>
      {open ? (
        <div
          data-disclaimer-gate
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="disclaimer-title"
            aria-describedby="disclaimer-text"
            className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-xl"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Antes de continuar</p>
            <h2 id="disclaimer-title" className="mt-1 text-lg font-semibold">
              Aviso importante
            </h2>
            <p id="disclaimer-text" className="mt-3 text-base leading-relaxed">
              {DISCLAIMER_TEXT}
            </p>
            <p className="mt-3 text-sm text-muted">
              Os alertas são gerados por um sistema automático a partir da transmissão, com as mesmas regras para
              todos os participantes.{" "}
              <Link href="/metodologia" className="underline">
                Entenda a metodologia
              </Link>
              .
            </p>
            <button
              ref={buttonRef}
              type="button"
              onClick={accept}
              className="mt-5 w-full rounded-lg bg-fg px-4 py-3 text-base font-semibold text-bg hover:opacity-90"
            >
              Entendi, quero continuar
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Lembrete permanente e discreto (mostrado também depois do aceite). */
export function DisclaimerBanner() {
  return (
    <div role="note" className="border-b border-border bg-surface-2 text-xs text-muted">
      <p className="mx-auto max-w-6xl px-4 py-1.5">
        Checagem automatizada — pode errar. Confira sempre a fonte de cada alerta.{" "}
        <Link href="/metodologia" className="underline">
          Como funciona
        </Link>
      </p>
    </div>
  );
}
