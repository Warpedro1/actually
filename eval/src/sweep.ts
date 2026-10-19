// pnpm --filter @actually/eval sweep -- --decisions eval/results/<ts>/decisions.jsonl
//   [--target 0.9] [--target-yellow 0.85] [--from 0.5] [--to 0.99] [--step 0.01] [--penalties 0,0.05,0.1,0.15]
// Varre t_red / t_yellow / web_penalty sobre decisões já salvas (sem chamar modelos).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSettings, type DebateSettings } from "@actually/db";
import { cliArgs, die, userPath } from "./cli";
import { parseDecisions } from "./dataset";
import { renderSweep } from "./report";
import { agreement, grid, recommend, sweepRed, sweepYellow, type Thresholds } from "./thresholds";

const args = cliArgs({
  decisions: { type: "string" },
  target: { type: "string", default: "0.9" },
  "target-yellow": { type: "string", default: "0.85" },
  from: { type: "string", default: "0.5" },
  to: { type: "string", default: "0.99" },
  step: { type: "string", default: "0.01" },
  penalties: { type: "string", default: "0,0.05,0.1,0.15" },
  "min-emitted": { type: "string", default: "1" },
});

if (!args.decisions) die("uso: sweep -- --decisions eval/results/<ts>/decisions.jsonl [--target 0.9]");
const file = userPath(args.decisions as string);
const recs = parseDecisions(readFileSync(file, "utf8"));
if (!recs.length) die("decisions.jsonl vazio");

const settingsFile = join(dirname(file), "settings.json");
const runSettings: DebateSettings = existsSync(settingsFile)
  ? resolveSettings(JSON.parse(readFileSync(settingsFile, "utf8")))
  : resolveSettings({});
const base: Thresholds = { t_red: runSettings.t_red, t_yellow: runSettings.t_yellow, web_penalty: runSettings.web_penalty };

const targetRed = Number(args.target);
const targetYellow = Number(args["target-yellow"]);
const minEmitted = Number(args["min-emitted"]);
const ts = grid(Number(args.from), Number(args.to), Number(args.step));
const penalties = (args.penalties as string).split(",").map(Number);

const byPenalty = penalties.map((web_penalty) => {
  const red = sweepRed(recs, { ...base, web_penalty }, ts);
  const recRed = recommend(red, "t_red", targetRed, (p) => p.precision, minEmitted);
  const tRedForYellow = recRed?.t_red ?? base.t_red;
  const yellow = sweepYellow(recs, { ...base, web_penalty, t_red: tRedForYellow }, ts);
  const recYellow = recommend(yellow, "t_yellow", targetYellow, (p) => p.lenient_precision ?? null, minEmitted);
  return { web_penalty, red, recRed, yellow, recYellow };
});

const md = renderSweep({
  decisions_file: args.decisions as string,
  base,
  agreement: agreement(recs, base),
  target_red: targetRed,
  target_yellow: targetYellow,
  byPenalty,
});
const outFile = join(dirname(file), "sweep.md");
writeFileSync(outFile, md + "\n");
console.log(md);
console.error(`\nsalvo em ${outFile}`);
