"use client";

import { useEffect, useState } from "react";
import { STORAGE_KEYS, storageGet, storageRemove, storageSet } from "@/lib/storage";

type Theme = "system" | "light" | "dark";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "Tema: automático", light: "Tema: claro", dark: "Tema: escuro" };

function Icon({ theme }: { theme: Theme }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (theme === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
    </svg>
  );
}

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
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted hover:text-fg"
      aria-label={`${LABEL[theme]}. Trocar tema`}
      title={LABEL[theme]}
    >
      <Icon theme={theme} />
    </button>
  );
}
