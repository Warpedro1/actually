"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { storageGet, storageSet } from "@/lib/storage";

export interface TabDef<T extends string> {
  id: T;
  label: string;
}

/**
 * Aba ativa do /admin: #hash da URL (link direto, ex.: /admin#base) > última
 * aba usada (localStorage) > primeira. Lida no efeito, não na renderização,
 * para o HTML do servidor e a hidratação concordarem.
 */
export function useAdminTab<T extends string>(ids: readonly T[], storageKey: string): [T, (id: T) => void] {
  const [active, setActive] = useState<T>(ids[0]!);
  const idsKey = ids.join("|");

  useEffect(() => {
    const valid = idsKey.split("|");
    const isTab = (v: string | null): v is T => v !== null && valid.includes(v);
    const fromHash = () => {
      const h = decodeURIComponent(window.location.hash.slice(1));
      return isTab(h) ? h : null;
    };
    const stored = storageGet(storageKey);
    setActive(fromHash() ?? (isTab(stored) ? stored : (valid[0] as T)));
    const onHash = () => {
      const h = fromHash();
      if (h) setActive(h);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [idsKey, storageKey]);

  const select = useCallback(
    (id: T) => {
      setActive(id);
      storageSet(storageKey, id);
      try {
        window.history.replaceState(window.history.state, "", `#${id}`);
      } catch {
        // sem history (raro): a aba troca do mesmo jeito
      }
    },
    [storageKey],
  );

  return [active, select];
}

/**
 * Abas no padrão WAI-ARIA (setas, Home e End trocam e movem o foco). Só o
 * conteúdo da aba ativa é montado: o polling e o Realtime das outras param.
 */
export function AdminTabs<T extends string>({
  tabs,
  active,
  onSelect,
  label,
  children,
}: {
  tabs: readonly TabDef<T>[];
  active: T;
  onSelect: (id: T) => void;
  label: string;
  children: ReactNode;
}) {
  const refs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({});

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.id === active);
    const next =
      e.key === "ArrowRight" ? (i + 1) % tabs.length
      : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next]!.id;
    onSelect(id);
    refs.current[id]?.focus();
  }

  return (
    <>
      <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`aba-${t.id}`}
              aria-selected={selected}
              aria-controls={selected ? `painel-${t.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(t.id)}
              className={`-mb-px min-h-10 shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
                selected ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`painel-${active}`} aria-labelledby={`aba-${active}`} className="flex flex-col gap-4">
        {children}
      </div>
    </>
  );
}
