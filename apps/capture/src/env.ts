// Carrega variáveis de arquivos .env sem sobrescrever o ambiente.
// Precedência (vence o primeiro que define a variável): ambiente do processo >
// ~/.actually/capture.env (o que o serviço instalado usa) > .env do diretório
// atual > .env da raiz do repo. Assim um .env de desenvolvimento (ex.: cópia do
// .env.example com ACTUALLY_API_URL=http://localhost:3000) nunca sobrescreve o
// do serviço.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** ~/.actually (ou ACTUALLY_HOME, útil para ensaios sem tocar no diretório real). */
export function actuallyHome(home?: string): string {
  if (home === undefined && process.env.ACTUALLY_HOME) return process.env.ACTUALLY_HOME;
  return join(home ?? homedir(), ".actually");
}

export function captureEnvPath(home?: string): string {
  return join(actuallyHome(home), "capture.env");
}

/** Raiz do monorepo (apps/capture/src → ../../..). */
export function repoRoot(): string {
  return resolve(fileURLToPath(new URL("../../..", import.meta.url)));
}

/** Arquivos lidos, do mais forte para o mais fraco. */
export function envFileCandidates(o: { cwd?: string; home?: string; repo?: string } = {}): string[] {
  const files = [captureEnvPath(o.home), resolve(o.cwd ?? process.cwd(), ".env"), join(o.repo ?? repoRoot(), ".env")];
  return [...new Set(files)];
}

export function loadEnvFiles(env: NodeJS.ProcessEnv = process.env, candidates: string[] = envFileCandidates()): string[] {
  const loaded: string[] = [];
  for (const file of candidates) {
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
