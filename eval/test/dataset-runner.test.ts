import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseDataset, parseDecisions, toJsonl } from "../src/dataset";
import { computeMetrics } from "../src/metrics";
import { renderReport } from "../src/report";
import { mapPool, runEval } from "../src/runner";
import { EVAL_DIR } from "../src/cli";
import { decision } from "./fixtures";

const base = {
  id: "x1",
  source: "sintetico",
  speaker: "A",
  t: 0,
  context: "",
  text: "fala",
  expected: { checkable: true, verdict: "contradito", alert: "red" },
  reference_urls: [],
  notes: "",
  synthetic: true,
};

describe("parseDataset", () => {
  it("smoke.jsonl é válido, sintético e balanceado entre A e B", () => {
    const { items, issues } = parseDataset(readFileSync(join(EVAL_DIR, "data", "smoke.jsonl"), "utf8"));
    expect(issues).toEqual([]);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.synthetic)).toBe(true);
    expect(new Set(items.map((i) => i.speaker))).toEqual(new Set(["A", "B"]));
    expect(items.filter((i) => i.speaker === "A").length).toBe(items.filter((i) => i.speaker === "B").length);
    expect(items.some((i) => i.expected.verdict === "confirmado")).toBe(true);
    expect(items.some((i) => !i.expected.checkable)).toBe(true);
  });

  it("aponta linhas inválidas sem lançar", () => {
    const lines = [
      JSON.stringify(base),
      "{não é json",
      JSON.stringify({ ...base, id: "x2", expected: { checkable: false, verdict: "contradito", alert: null } }),
      JSON.stringify({ ...base, id: "x3", expected: { checkable: true, verdict: "confirmado", alert: "red" } }),
      JSON.stringify(base), // id duplicado
      JSON.stringify({ ...base, id: "x4", synthetic: false }), // real sem referência
      "",
      "// comentário",
    ].join("\n");
    const { items, issues } = parseDataset(lines);
    expect(items.map((i) => i.id)).toEqual(["x1"]);
    expect(issues.map((i) => i.line)).toEqual([2, 3, 4, 5, 6]);
  });
});

describe("runEval (evaluateText mockado)", () => {
  it("captura decisões, erros e tempo; respeita a ordem e as settings", async () => {
    const { items } = parseDataset(
      [JSON.stringify(base), JSON.stringify({ ...base, id: "x2", text: "falha" }), JSON.stringify({ ...base, id: "x3", text: "nada" })].join("\n"),
    );
    const evaluate = vi.fn(async (text: string) => {
      if (text === "falha") throw new Error("anthropic 529");
      if (text === "nada") return [];
      return [decision()];
    });
    const progress = vi.fn();
    const recs = await runEval(items, evaluate, { concurrency: 2, settings: { t_red: 0.9 }, onProgress: progress });
    expect(recs.map((r) => r.item_id)).toEqual(["x1", "x2", "x3"]);
    expect(recs[1]!.error).toBe("anthropic 529");
    expect(recs[2]!.decisions).toEqual([]);
    expect(evaluate).toHaveBeenCalledWith("fala", "", { settings: { t_red: 0.9 } });
    expect(progress).toHaveBeenCalledTimes(3);

    // ida e volta pelo cache
    const back = parseDecisions(toJsonl(recs));
    expect(back).toEqual(recs);

    const md = renderReport(computeMetrics(back), {
      data_file: "x.jsonl",
      started_at: "2026-10-19T00:00:00Z",
      settings: {},
      concurrency: 2,
      red_precision_target: 0.9,
    });
    expect(md).toContain("# Relatório de avaliação");
    expect(md).toContain("anthropic 529");
    expect(md).toContain("Só itens sintéticos");
  });

  it("mapPool limita concorrência", async () => {
    let inFlight = 0, peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6], 2, async (x) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});
