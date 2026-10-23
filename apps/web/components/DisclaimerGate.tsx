"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DISCLAIMER_INTRO, DISCLAIMER_POINTS, DISCLAIMER_VERSION } from "@/lib/disclaimer";
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
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-4 sm:items-center"
        >
          {/* max-h + rolagem: o aviso é longo e o botão não pode sair da tela no celular */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="disclaimer-title"
            aria-describedby="disclaimer-text"
            className="flex max-h-[92dvh] w-full max-w-md flex-col overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl"
          >
            <h2 id="disclaimer-title" className="text-lg font-semibold">
              Antes de começar
            </h2>
            <div id="disclaimer-text" className="mt-3 space-y-3 text-sm leading-relaxed sm:text-base">
              {DISCLAIMER_INTRO.map((p) => (
                <p key={p}>{p}</p>
              ))}
              <ul className="list-disc space-y-2 pl-5">
                {DISCLAIMER_POINTS.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
            <p className="mt-3 text-sm text-muted">
              <Link href="/metodologia" className="underline">
                Como a checagem funciona, em detalhe
              </Link>
            </p>
            <button
              ref={buttonRef}
              type="button"
              onClick={accept}
              className="mt-5 w-full shrink-0 rounded-lg bg-fg px-4 py-3 text-base font-semibold text-bg hover:opacity-90"
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
        Projeto em desenvolvimento — checagem automatizada, pode errar. Confira sempre a fonte de cada alerta.{" "}
        <Link href="/metodologia" className="underline">
          Como funciona
        </Link>
      </p>
    </div>
  );
}
