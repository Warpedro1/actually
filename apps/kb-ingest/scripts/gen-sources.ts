// Gera src/generated/sources.ts a partir de sources/apify.yaml e sources/feeds.yaml.
// O painel do /admin roda o kb-ingest na Vercel, onde os YAML não estão no disco
// da função; o conteúdo vai embutido no código. Rode depois de editar os YAML:
//   pnpm --filter @actually/kb-ingest gen:sources
// test/jobs.test.ts falha se o arquivo gerado ficar diferente dos YAML.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const dir = resolve(import.meta.dirname, "..");

export function generatedSources(): string {
  const apify = parseYaml(readFileSync(resolve(dir, "sources/apify.yaml"), "utf8")) ?? {};
  const feeds = parseYaml(readFileSync(resolve(dir, "sources/feeds.yaml"), "utf8")) ?? {};
  return `// GERADO por scripts/gen-sources.ts a partir de sources/*.yaml — não edite à mão.
// Rode \`pnpm --filter @actually/kb-ingest gen:sources\` depois de mudar os YAML.

export const APIFY_MANIFEST_RAW: unknown = ${JSON.stringify(apify, null, 2)};

export const FEEDS_RAW: unknown = ${JSON.stringify(feeds, null, 2)};
`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  writeFileSync(resolve(dir, "src/generated/sources.ts"), generatedSources());
  console.log("src/generated/sources.ts atualizado");
}
