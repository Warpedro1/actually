// pnpm --filter @actually/eval latency-report -- --debate <slug> [--json]
// Lê verifications.latency_ms e alerts de um debate no Supabase e imprime p50/p95
// por etapa, fim da fala → alerta, e a espera do editor (insumo para decidir o HITL).
// Requer NEXT_PUBLIC_SUPABASE_URL (ou SUPABASE_URL) e SUPABASE_SERVICE_ROLE_KEY (lidos do .env da raiz).
import { serviceClient } from "@actually/db";
import { cliArgs, die, loadRootEnv } from "./cli";
import { editorStats, renderLatencyReport, stageLatency, type AlertRow, type VerificationRow } from "./latency";

const args = cliArgs({ debate: { type: "string" }, json: { type: "boolean", default: false } });
if (!args.debate) die("uso: latency-report -- --debate <slug> [--json]");
const slug = args.debate as string;

loadRootEnv();
const db = serviceClient();
const PAGE = 1000;

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) die(`erro do Supabase: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

const { data: debate, error } = await db.from("debates").select("id, title").eq("slug", slug).maybeSingle();
if (error) die(`erro do Supabase: ${error.message}`);
if (!debate) die(`debate não encontrado: ${slug}`);

const verifications = await fetchAll<VerificationRow>((from, to) =>
  db
    .from("verifications")
    .select("latency_ms, claims!inner(debate_id)")
    .eq("claims.debate_id", debate.id)
    .order("created_at")
    .range(from, to),
);

type RawAlert = Omit<AlertRow, "segment_captured_at"> & { claims: unknown };
const rawAlerts = await fetchAll<RawAlert>((from, to) =>
  db
    .from("alerts")
    .select("id, status, verdict, is_repeat, created_at, published_at, reviewed_at, claims(segments(captured_at))")
    .eq("debate_id", debate.id)
    .order("created_at")
    .range(from, to),
);

/** O embed pode vir como objeto ou lista, conforme o PostgREST infere a relação. */
function one(x: unknown): Record<string, unknown> | null {
  if (Array.isArray(x)) return (x[0] as Record<string, unknown>) ?? null;
  return (x as Record<string, unknown>) ?? null;
}

const alerts: AlertRow[] = rawAlerts.map(({ claims, ...a }) => {
  const seg = one(one(claims)?.segments);
  return { ...a, segment_captured_at: (seg?.captured_at as string | undefined) ?? null };
});

const stages = stageLatency(verifications);
const ed = editorStats(alerts);
if (args.json) console.log(JSON.stringify({ debate: slug, verifications: verifications.length, stages, editor: ed }, null, 2));
else console.log(renderLatencyReport(slug, stages, verifications.length, ed));
