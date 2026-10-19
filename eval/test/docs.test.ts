import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_DIR } from "../src/cli";
import { extractBlock, renderTiersTable } from "../src/tiers-table";

describe("docs/metodologia.md", () => {
  it("tabela de tiers está em sincronia com SOURCE_TIERS", () => {
    const md = readFileSync(join(EVAL_DIR, "..", "docs", "metodologia.md"), "utf8");
    expect(extractBlock(md), "rode `pnpm --filter @actually/eval tiers-table` e cole o bloco").toBe(renderTiersTable());
  });
});
