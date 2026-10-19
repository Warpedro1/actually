// Utilitários de linha de comando compartilhados pelos scripts do eval.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsConfig } from "node:util";

/** pnpm repassa um "--" literal quando o script é chamado como `pnpm eval -- --data ...`. */
export function cliArgs(options: NonNullable<ParseArgsConfig["options"]>, argv = process.argv.slice(2)) {
  return parseArgs({ args: argv.filter((a) => a !== "--"), options, allowPositionals: false, strict: true }).values;
}

/** Caminhos relativos são resolvidos a partir de onde o usuário rodou o pnpm (INIT_CWD). */
export function userPath(p: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

/** Diretório do pacote eval/ (independe do cwd). */
export const EVAL_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Carrega o .env da raiz do repo, se existir (variáveis já definidas têm precedência). */
export function loadRootEnv(): void {
  const file = resolve(EVAL_DIR, "..", ".env");
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  Object.assign(process.env, before);
}

export function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export function timestampDir(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}
