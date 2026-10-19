// Carrega variáveis de arquivos .env sem sobrescrever o ambiente.
// Precedência (vence o primeiro que define a variável): ambiente do processo >
// ~/.actually/capture.env (o que o serviço instalado usa) > .env do diretório
// atual > .env da raiz do repo. Assim um .env de desenvolvimento (ex.: cópia do
// .env.example com ACTUALLY_API_URL=http://localhost:3000) nunca sobrescreve o
// do serviço. O avesso também é armadilha: numa máquina que é de dev e de
// captura, o `run` do terminal mandaria um teste local para a API de produção.
// Por isso, quando a URL vem só dos arquivos e eles discordam, o `run` exige
// --api (apiUrlConflict) e sempre mostra para onde vai enviar.

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

export interface EnvFileValue {
  file: string;
  value: string;
}

/** Valores não vazios de `key` em cada arquivo, do mais forte para o mais fraco. */
export function envFileValues(key: string, candidates: string[] = envFileCandidates()): EnvFileValue[] {
  const out: EnvFileValue[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const v = parseEnv(readFileSync(file, "utf8"))[key]?.trim();
      if (v) out.push({ file, value: v });
    } catch {
      /* arquivo ilegível: loadEnvFiles também o ignora */
    }
  }
  return out;
}

/**
 * ACTUALLY_API_URL diferente entre os arquivos .env (ex.: capture.env de
 * produção + .env de dev com localhost): devolve a explicação, ou null se todos
 * concordam. Só importa quando a URL não veio de --api nem do ambiente do processo.
 */
export function apiUrlConflict(values: EnvFileValue[]): string | null {
  const distinct = new Set(values.map((v) => v.value.replace(/\/+$/, "")));
  if (distinct.size <= 1) return null;
  return `ACTUALLY_API_URL diverge entre os arquivos .env (${values.map((v) => `${v.file} → ${v.value}`).join("; ")})`;
}
