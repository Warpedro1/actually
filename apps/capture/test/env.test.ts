import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { apiUrlConflict, captureEnvPath, envFileCandidates, envFileValues, loadEnvFiles } from "../src/env";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "capture-env-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const cwd = join(repo, "apps", "capture");
  mkdirSync(join(home, ".actually"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd, repo };
}

describe("[RF13] precedência das variáveis: processo > ~/.actually/capture.env > .env local", () => {
  it("ordem dos arquivos: capture.env do serviço primeiro, depois .env do diretório atual, depois o do repo", () => {
    const { home, cwd, repo } = setup();
    expect(envFileCandidates({ home, cwd, repo })).toEqual([captureEnvPath(home), join(cwd, ".env"), join(repo, ".env")]);
  });

  it(".env de desenvolvimento (cópia do .env.example com localhost) não sobrescreve o capture.env do serviço", () => {
    const { home, cwd, repo } = setup();
    writeFileSync(captureEnvPath(home), "ACTUALLY_API_URL=https://actually.vercel.app\nINGEST_TOKEN=tok-prod\nDEEPGRAM_API_KEY=\n");
    writeFileSync(join(cwd, ".env"), "ACTUALLY_API_URL=http://localhost:3000\nINGEST_TOKEN=tok-dev\nDEEPGRAM_API_KEY=dg-local\n");
    writeFileSync(join(repo, ".env"), "ACTUALLY_API_URL=http://localhost:3000\nINGEST_TOKEN=tok-repo\nSO_NO_REPO=1\n");
    const env: NodeJS.ProcessEnv = { CAPTURE_STT_MODEL: "nova-2" };
    const loaded = loadEnvFiles(env, envFileCandidates({ home, cwd, repo }));
    expect(loaded).toHaveLength(3);
    expect(env.ACTUALLY_API_URL).toBe("https://actually.vercel.app");
    expect(env.INGEST_TOKEN).toBe("tok-prod");
    // vazio no capture.env = não definido: vale o próximo arquivo
    expect(env.DEEPGRAM_API_KEY).toBe("dg-local");
    expect(env.SO_NO_REPO).toBe("1");
    expect(env.CAPTURE_STT_MODEL).toBe("nova-2");
  });

  it("variável do processo vence todos os arquivos", () => {
    const { home, cwd, repo } = setup();
    writeFileSync(captureEnvPath(home), "ACTUALLY_API_URL=https://actually.vercel.app\n");
    writeFileSync(join(cwd, ".env"), "ACTUALLY_API_URL=http://localhost:3000\n");
    const env: NodeJS.ProcessEnv = { ACTUALLY_API_URL: "https://ensaio.vercel.app" };
    loadEnvFiles(env, envFileCandidates({ home, cwd, repo }));
    expect(env.ACTUALLY_API_URL).toBe("https://ensaio.vercel.app");
  });
});

describe("[RF01] `run` no terminal não adivinha a API quando os .env discordam (teste local não vai para o debate real)", () => {
  it("máquina de dev e de captura: capture.env de produção + .env local com localhost ⇒ conflito (exige --api)", () => {
    const { home, cwd, repo } = setup();
    writeFileSync(captureEnvPath(home), "ACTUALLY_API_URL=https://actually.vercel.app\nINGEST_TOKEN=tok-prod\n");
    writeFileSync(join(repo, ".env"), "ACTUALLY_API_URL=http://localhost:3000\n");
    const values = envFileValues("ACTUALLY_API_URL", envFileCandidates({ home, cwd, repo }));
    expect(values).toEqual([
      { file: captureEnvPath(home), value: "https://actually.vercel.app" },
      { file: join(repo, ".env"), value: "http://localhost:3000" },
    ]);
    const msg = apiUrlConflict(values);
    expect(msg).toContain("https://actually.vercel.app");
    expect(msg).toContain("http://localhost:3000");
  });

  it("sem conflito: só o capture.env, valores iguais (barra final não conta) ou vazio no .env de dev", () => {
    const { home, cwd, repo } = setup();
    writeFileSync(captureEnvPath(home), "ACTUALLY_API_URL=https://actually.vercel.app\n");
    const c = envFileCandidates({ home, cwd, repo });
    expect(apiUrlConflict(envFileValues("ACTUALLY_API_URL", c))).toBeNull();
    writeFileSync(join(cwd, ".env"), "ACTUALLY_API_URL=https://actually.vercel.app/\n");
    writeFileSync(join(repo, ".env"), "ACTUALLY_API_URL=\n");
    expect(envFileValues("ACTUALLY_API_URL", c)).toHaveLength(2);
    expect(apiUrlConflict(envFileValues("ACTUALLY_API_URL", c))).toBeNull();
    expect(apiUrlConflict([])).toBeNull();
  });
});
