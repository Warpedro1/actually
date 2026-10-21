// Gera src/generated/sources.ts a partir de sources/apify.yaml, sources/feeds.yaml e
// sources/manual/*.yaml (séries manuais da L2).
// O painel do /admin roda o kb-ingest na Vercel, onde os YAML não estão no disco
// da função; o conteúdo vai embutido no código. Rode depois de editar os YAML:
//   pnpm --filter @actually/kb-ingest gen:sources
// test/jobs.test.ts falha se o arquivo gerado ficar diferente dos YAML.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const dir = resolve(import.meta.dirname, "..");

/** sources/manual/<nome>.yaml → { nome: conteúdo }, em ordem alfabética. */
function manualSeries(): Record<string, unknown> {
  const manualDir = resolve(dir, "sources/manual");
  const files = readdirSync(manualDir).filter((f) => f.endsWith(".yaml")).sort();
  return Object.fromEntries(files.map((f) => [f.replace(/\.yaml$/, ""), parseYaml(readFileSync(resolve(manualDir, f), "utf8")) ?? {}]));
}

export function generatedSources(): string {
  const apify = parseYaml(readFileSync(resolve(dir, "sources/apify.yaml"), "utf8")) ?? {};
  const feeds = parseYaml(readFileSync(resolve(dir, "sources/feeds.yaml"), "utf8")) ?? {};
  return `// GERADO por scripts/gen-sources.ts a partir de sources/*.yaml — não edite à mão.
// Rode \`pnpm --filter @actually/kb-ingest gen:sources\` depois de mudar os YAML.

export const APIFY_MANIFEST_RAW: unknown = ${JSON.stringify(apify, null, 2)};

export const FEEDS_RAW: unknown = ${JSON.stringify(feeds, null, 2)};

/** sources/manual/<arquivo>.yaml por nome do arquivo (séries manuais da L2; ver src/indicators/manual.ts). */
export const MANUAL_SERIES_RAW: Record<string, unknown> = ${JSON.stringify(manualSeries(), null, 2)};
`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  writeFileSync(resolve(dir, "src/generated/sources.ts"), generatedSources());
  console.log("src/generated/sources.ts atualizado");
}
