// Manifesto de documentos (sources/documents.yaml) e metadados de --meta.
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DOC_TYPES } from "./ingest";

const dateish = z
  .union([z.string(), z.date()])
  .transform((v) => (v instanceof Date ? v.toISOString() : v))
  .refine((v) => Number.isFinite(Date.parse(v)), "data inválida");

export const ManifestEntry = z.object({
  url: z.string().regex(/^https?:\/\//, "url precisa ser http(s)"),
  title: z.string().min(1),
  doc_type: z.enum(DOC_TYPES as [string, ...string[]]),
  person: z.string().nullish(),
  source_name: z.string().nullish(),
  tier: z.number().int().min(1).max(4).nullish(),
  topics: z.array(z.string()).nullish(),
  published_at: dateish.nullish(),
  /** html | pdf | text — se omitido, decide pelo Content-Type. */
  format: z.enum(["html", "pdf", "text"]).nullish(),
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;

export const Manifest = z.object({ documents: z.array(ManifestEntry).nullish() });

export function loadManifest(path: string): ManifestEntry[] {
  const raw = parseYaml(readFileSync(path, "utf8")) ?? {};
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) throw new Error(`manifesto inválido (${path}): ${parsed.error.message}`);
  return parsed.data.documents ?? [];
}

/** --meta para arquivos locais: mesmos campos, url é a referência pública obrigatória. */
export const LocalMeta = ManifestEntry.omit({ format: true });
export type LocalMeta = z.infer<typeof LocalMeta>;
