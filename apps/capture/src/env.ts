// Carrega variáveis de arquivos .env sem sobrescrever o ambiente.
// Ordem: .env do diretório atual, .env da raiz do repo, ~/.actually/capture.env
// (este último é o que o serviço instalado usa).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export function actuallyHome(home: string = homedir()): string {
  return join(home, ".actually");
}

export function captureEnvPath(home: string = homedir()): string {
  return join(actuallyHome(home), "capture.env");
}

/** Raiz do monorepo (apps/capture/src → ../../..). */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL("../../..", import.meta.url)));
}

export function loadEnvFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [resolve(".env"), join(repoRoot(), ".env"), captureEnvPath()];
  const loaded: string[] = [];
  for (const file of [...new Set(candidates)]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = parseEnv(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (env[k] === undefined || env[k] === "") env[k] = v;
      }
      loaded.push(file);
    } catch {
      /* arquivo ilegível: segue com o que tem */
    }
  }
  return loaded;
}
