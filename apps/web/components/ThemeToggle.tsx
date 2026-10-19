"use client";

import { useEffect, useState } from "react";
import { STORAGE_KEYS, storageGet, storageRemove, storageSet } from "@/lib/storage";

type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "Tema: sistema", light: "Tema: claro", dark: "Tema: escuro" };
const ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const t = storageGet(STORAGE_KEYS.theme);
    if (t === "light" || t === "dark") setTheme(t);
  }, []);

  function cycle() {
    const next = NEXT[theme];
    setTheme(next);
    const root = document.documentElement;
    if (next === "system") {
      root.removeAttribute("data-theme");
      storageRemove(STORAGE_KEYS.theme);
    } else {
      root.setAttribute("data-theme", next);
      storageSet(STORAGE_KEYS.theme, next);
    }
  }

  return (
    <button
      type="button"
      onClick={cycle}
      className="inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-md border border-border px-2 text-sm text-muted hover:text-fg"
      aria-label={`${LABEL[theme]}. Trocar tema`}
      title={LABEL[theme]}
    >
      <span aria-hidden="true">{ICON[theme]}</span>
    </button>
  );
}
