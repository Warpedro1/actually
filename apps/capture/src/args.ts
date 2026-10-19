// Parsing de argumentos (node:util parseArgs). Puro: argv + env → comando.

import { parseArgs } from "node:util";
import { DEFAULT_YTDLP_FORMAT, type SourceSpec } from "./audio";
import { DEFAULT_STT_MODEL, FALLBACK_STT_MODEL } from "./deepgram";

export const DEFAULT_LOG_DIR = "./capture-logs";

export interface RunArgs {
  debate: string;
  name: string;
  role: "primary" | "standby";
  source: SourceSpec;
  api: string | null;
  /** api veio de --api (e não de ACTUALLY_API_URL). */
  apiFromFlag: boolean;
  sttModel: string;
  sttFallbackModel: string;
  dryRun: boolean;
  logDir: string;
}

export type Command =
  | { cmd: "help" }
  | { cmd: "run"; args: RunArgs }
  | { cmd: "doctor"; api: string | null; url: string | null; device: string | null; ytdlpFormat: string }
  | { cmd: "devices" }
  | { cmd: "daemon"; name: string; api: string | null; logDir: string; supervise: boolean }
  | { cmd: "install-service"; name: string; api: string | null; logDir: string | null; print: boolean }
  | { cmd: "uninstall-service"; print: boolean };

export class CliError extends Error {}

export const USAGE = `uso: capture <comando> [opções]

comandos:
  run       captura, transcreve e envia para a API
            --debate <slug> --name <nome> --role primary|standby
            --source youtube --url <url> [--ytdlp-format <fmt>]
            --source device --device <spec>   (macOS ":0" | Linux pulse "<sink>.monitor" | Windows "audio=<nome>")
            --source file --file <caminho> [--no-realtime]
            [--api <url>] [--stt-model nova-3] [--stt-fallback-model nova-2] [--dry-run] [--log-dir ./capture-logs]
  doctor    checa dependências, variáveis e API [--api <url>] [--url <live>] [--device <spec>]
  devices   lista dispositivos de áudio do sistema
  daemon    controle remoto pelo /admin: --name <máquina> [--api <url>] [--log-dir <dir>]
  install-service    instala o daemon como serviço do SO: --name <máquina> [--api <url>] [--print]
  uninstall-service  remove o serviço [--print]

variáveis: DEEPGRAM_API_KEY, INGEST_TOKEN, ACTUALLY_API_URL (ambiente > ~/.actually/capture.env > .env local)`;

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Command {
  // `pnpm start -- run ...` pode repassar o "--"
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return { cmd: "help" };
  switch (cmd) {
    case "run":
      return { cmd: "run", args: parseRun(rest, env) };
    case "doctor": {
      const { values } = parse(rest, {
        api: { type: "string" },
        url: { type: "string" },
        device: { type: "string" },
        "ytdlp-format": { type: "string" },
      });
      return {
        cmd: "doctor",
        api: str(values.api) ?? env.ACTUALLY_API_URL ?? null,
        url: str(values.url) ?? null,
        device: str(values.device) ?? null,
        ytdlpFormat: str(values["ytdlp-format"]) ?? DEFAULT_YTDLP_FORMAT,
      };
    }
    case "devices":
      parse(rest, {});
      return { cmd: "devices" };
    case "daemon": {
      const { values } = parse(rest, {
        name: { type: "string" },
        api: { type: "string" },
        "log-dir": { type: "string" },
        supervise: { type: "boolean" },
      });
      return {
        cmd: "daemon",
        name: requireName(str(values.name)),
        api: str(values.api) ?? env.ACTUALLY_API_URL ?? null,
        logDir: str(values["log-dir"]) ?? DEFAULT_LOG_DIR,
        supervise: values.supervise === true,
      };
    }
    case "install-service": {
      const { values } = parse(rest, {
        name: { type: "string" },
        api: { type: "string" },
        "log-dir": { type: "string" },
        print: { type: "boolean" },
      });
      return {
        cmd: "install-service",
        name: requireName(str(values.name)),
        api: str(values.api) ?? null,
        logDir: str(values["log-dir"]) ?? null,
        print: values.print === true,
      };
    }
    case "uninstall-service": {
      const { values } = parse(rest, { print: { type: "boolean" } });
      return { cmd: "uninstall-service", print: values.print === true };
    }
    default:
      throw new CliError(`comando desconhecido: ${cmd}`);
  }
}

function parseRun(rest: string[], env: NodeJS.ProcessEnv): RunArgs {
  const { values } = parse(rest, {
    debate: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    source: { type: "string" },
    url: { type: "string" },
    device: { type: "string" },
    file: { type: "string" },
    realtime: { type: "boolean" },
    "no-realtime": { type: "boolean" },
    "ytdlp-format": { type: "string" },
    api: { type: "string" },
    "stt-model": { type: "string" },
    "stt-fallback-model": { type: "string" },
    "dry-run": { type: "boolean" },
    "log-dir": { type: "string" },
  });
  const debate = str(values.debate);
  if (!debate) throw new CliError("--debate <slug> é obrigatório");
  const name = requireName(str(values.name));
  const role = str(values.role) ?? "primary";
  if (role !== "primary" && role !== "standby") throw new CliError("--role deve ser primary ou standby");

  const source = buildSource(
    {
      source: str(values.source),
      url: str(values.url),
      device: str(values.device),
      file: str(values.file),
      realtime: values["no-realtime"] !== true,
      ytdlpFormat: str(values["ytdlp-format"]),
    },
    CliError,
  );

  const dryRun = values["dry-run"] === true;
  const api = str(values.api) ?? env.ACTUALLY_API_URL ?? null;
  if (!dryRun && !api) throw new CliError("--api <url> (ou ACTUALLY_API_URL) é obrigatório fora do --dry-run");

  return {
    debate,
    name,
    role,
    source,
    api: dryRun ? null : api,
    apiFromFlag: str(values.api) !== undefined,
    sttModel: str(values["stt-model"]) ?? DEFAULT_STT_MODEL,
    sttFallbackModel: str(values["stt-fallback-model"]) ?? FALLBACK_STT_MODEL,
    dryRun,
    logDir: str(values["log-dir"]) ?? DEFAULT_LOG_DIR,
  };
}

/** Também usado pelo daemon para validar o estado desejado vindo do /admin. */
export function buildSource(
  o: { source?: string; url?: string; device?: string; file?: string; realtime?: boolean; ytdlpFormat?: string },
  E: new (msg: string) => Error = Error,
): SourceSpec {
  switch (o.source) {
    case "youtube":
      if (!o.url) throw new E("--source youtube exige --url");
      return { kind: "youtube", url: o.url, format: o.ytdlpFormat ?? DEFAULT_YTDLP_FORMAT };
    case "device":
      if (!o.device) throw new E("--source device exige --device (veja `capture devices`)");
      return { kind: "device", device: o.device };
    case "file":
      if (!o.file) throw new E("--source file exige --file");
      return { kind: "file", path: o.file, realtime: o.realtime ?? true };
    case undefined:
      throw new E("--source youtube|device|file é obrigatório");
    default:
      throw new E(`--source inválido: ${o.source}`);
  }
}

type Opts = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

function parse(rest: string[], options: Opts): { values: Record<string, string | boolean | undefined> } {
  try {
    const { values } = parseArgs({ args: rest, options, allowPositionals: false, strict: true });
    return { values: values as Record<string, string | boolean | undefined> };
  } catch (err) {
    throw new CliError((err as Error).message);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function requireName(name: string | undefined): string {
  if (!name) throw new CliError("--name <nome> é obrigatório");
  if (name.length > 80) throw new CliError("--name tem no máximo 80 caracteres");
  return name;
}
