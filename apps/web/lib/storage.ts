// localStorage pode lançar (modo privado, cookies bloqueados, preview).
// Toda leitura/escrita passa por aqui e falha em silêncio.

export const STORAGE_KEYS = {
  disclaimer: "actually:disclaimer",
  viewMode: "actually:view-mode",
  theme: "actually:theme",
} as const;

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Retorna false se não conseguiu gravar. */
export function storageSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return window.localStorage.getItem(key) === value;
  } catch {
    return false;
  }
}

export function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // nada a fazer
  }
}
