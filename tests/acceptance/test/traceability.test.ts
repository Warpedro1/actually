// Rastreabilidade: todo requisito de docs/requisitos.md precisa de pelo menos
// um teste automático marcado com o seu ID ("[RF05]", "[RNF03]") em algum
// arquivo de teste do repositório.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP = new Set(["node_modules", ".git", ".next", "dist", ".claude"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) testFiles(p, out);
    else if (/\.(test|spec)\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const requirements = [...fs.readFileSync(path.join(root, "docs/requisitos.md"), "utf8")
  .matchAll(/^\| (RN?F\d{2}) \|/gm)].map((m) => m[1]!);

const corpus = testFiles(root).map((f) => fs.readFileSync(f, "utf8")).join("\n");

describe("rastreabilidade RF/RNF → testes", () => {
  it("docs/requisitos.md lista RF01–RF16 e RNF01–RNF10", () => {
    expect(requirements.filter((r) => r.startsWith("RF"))).toHaveLength(16);
    expect(requirements.filter((r) => r.startsWith("RNF"))).toHaveLength(10);
  });

  it.each(requirements)("%s tem teste marcado", (id) => {
    expect(corpus.includes(`[${id}]`), `nenhum teste marcado com [${id}]`).toBe(true);
  });
});
