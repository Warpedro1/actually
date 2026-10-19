// pnpm eval -- --data eval/data/x.jsonl [--concurrency 4] [--settings '{"t_red":0.9}'] [--out dir]
// Roda evaluateText em cada item, salva as decisões cruas e gera report.md + metrics.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSettings, type DebateSettings } from "@actually/db";
import { cliArgs, die, EVAL_DIR, loadRootEnv, timestampDir, userPath } from "./cli";
import { parseDataset, toJsonl } from "./dataset";
import { computeMetrics, predictedAlert } from "./metrics";
import { renderReport } from "./report";
import { runEval } from "./runner";

const args = cliArgs({
  data: { type: "string" },
  concurrency: { type: "string", default: "4" },
  settings: { type: "string" },
  out: { type: "string" },
  target: { type: "string", default: "0.9" },
});

if (!args.data) die("uso: pnpm eval -- --data eval/data/<arquivo>.jsonl [--concurrency 4] [--settings '{...}'] [--out <dir>]");
const dataPath = userPath(args.data as string);
const concurrency = Number(args.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1) die("--concurrency deve ser inteiro ≥ 1");

let override: Partial<DebateSettings> = {};
if (args.settings) {
  try {
    override = JSON.parse(args.settings as string);
  } catch (e) {
    die(`--settings não é JSON válido: ${(e as Error).message}`);
  }
}
const settings = resolveSettings(override);

const { items, issues } = parseDataset(readFileSync(dataPath, "utf8"));
for (const i of issues) console.error(`${args.data}:${i.line}: ${i.message}`);
if (issues.length) die(`${issues.length} linha(s) inválida(s) — corrija o conjunto antes de avaliar.`);
if (!items.length) die("conjunto vazio");

const startedAt = new Date();
const outDir = args.out ? userPath(args.out as string) : join(EVAL_DIR, "results", timestampDir(startedAt));
mkdirSync(outDir, { recursive: true });
console.error(`${items.length} itens · concorrência ${concurrency} · saída ${outDir}`);

loadRootEnv();
// import dinâmico: o pipeline só é carregado depois do .env
const { evaluateText } = await import("@actually/pipeline");
const records = await runEval(items, evaluateText, {
  concurrency,
  settings,
  onProgress: (done, total, rec) => {
    const tag = rec.error ? `ERRO ${rec.error.slice(0, 80)}` : `${predictedAlert(rec) ?? "silêncio"} (esperado ${rec.expected.alert ?? "nenhum"})`;
    console.error(`[${done}/${total}] ${rec.item_id}: ${tag} · ${Math.round(rec.wall_ms)} ms`);
  },
});

writeFileSync(join(outDir, "decisions.jsonl"), toJsonl(records));
const metrics = computeMetrics(records);
const meta = {
  data_file: args.data as string,
  started_at: startedAt.toISOString(),
  settings: settings as unknown as Record<string, unknown>,
  concurrency,
  red_precision_target: Number(args.target),
};
writeFileSync(join(outDir, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
writeFileSync(join(outDir, "metrics.json"), JSON.stringify({ meta, ...metrics }, null, 2) + "\n");
writeFileSync(join(outDir, "report.md"), renderReport(metrics, meta) + "\n");

console.log(`precisão vermelho: ${metrics.red.precision ?? "—"} · recall vermelho: ${metrics.red.recall ?? "—"} · erros: ${metrics.silence.errors.hits}`);
console.log(`relatório: ${join(outDir, "report.md")}`);
