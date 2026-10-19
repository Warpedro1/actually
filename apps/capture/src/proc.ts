// Executa um comando sem shell e coleta a saída (doctor, devices, install-service).

import { spawn } from "node:child_process";

export interface CmdResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** ENOENT etc. */
  error: string | null;
  timedOut: boolean;
}

export function runCmd(cmd: string, args: string[], timeoutMs = 30_000): Promise<CmdResult> {
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    let err = "";
    let timedOut = false;
    let settled = false;
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.setEncoding("utf8");
    p.stderr.on("data", (s: string) => (err += s));
    const finish = (code: number | null, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err, error, timedOut });
    };
    p.on("error", (e) => finish(null, e.message));
    p.on("close", (code) => finish(code, null));
  });
}
