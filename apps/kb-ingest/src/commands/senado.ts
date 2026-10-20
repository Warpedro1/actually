// senado: votações nominais (e, opcionalmente, discursos) do senador Flávio Bolsonaro.
//   --nome "Flávio Bolsonaro"   nome parlamentar a procurar (padrão)
//   --codigo N                  pula a busca por nome
//   --since 2019-02-01 --until  período (padrão: início da legislatura 56 até hoje)
//   --discursos                 também ingere discursos (texto integral) como doc_type "discurso"
import type { Person } from "../lib/classify";
import type { Ctx } from "../lib/ctx";
import { fetchJson, fetchText } from "../lib/http";
import { cleanText } from "../lib/text";
import { detectTopics } from "../lib/classify";
import { ingestDocument, type DocumentInput } from "../documents/ingest";
import {
  compactDate,
  findSenador,
  type DiscursoResumo,
  parseDiscursos,
  parseSenadores,
  parseVotacoes,
  SENADO_BASE,
  votacaoToDocument,
  yearWindows,
} from "../senado/api";

export interface SenadoOpts {
  nome?: string;
  codigo?: number;
  since?: string;
  until?: string;
  discursos?: boolean;
  skipEmbed?: boolean;
  limit?: number;
}

export const SENADO_PERSON: Person = "Flávio Bolsonaro";
/** Posse da 56ª legislatura (início do mandato de senador). */
export const SENADO_SINCE = "2019-02-01";

export async function resolveCodigo(ctx: Pick<Ctx, "log">, nome: string): Promise<number> {
  for (const path of ["/senador/lista/atual.json", "/senador/afastados.json"]) {
    const list = parseSenadores(await fetchJson(`${SENADO_BASE}${path}`));
    const s = findSenador(list, nome);
    if (s) {
      ctx.log(`senador: ${s.nome} (código ${s.codigo}, ${s.partido ?? "?"}-${s.uf ?? "?"}) via ${path}`);
      return s.codigo;
    }
  }
  throw new Error(`não encontrei "${nome}" nas listas de senadores em exercício/afastados; use --codigo`);
}

/** Votações nominais do parlamentar na janela [a, b] → documentos L3. */
export async function votesDocuments(codigo: number, a: string, b: string, person: string = SENADO_PERSON): Promise<{ votes: number; docs: DocumentInput[] }> {
  const qs = new URLSearchParams({ codigoParlamentar: String(codigo), dataInicio: a, dataFim: b });
  const votos = parseVotacoes(await fetchJson(`${SENADO_BASE}/votacao.json?${qs}`, { timeoutMs: 60_000 }), codigo);
  const docs = votos.map((v) => votacaoToDocument(v, person)).filter((d): d is DocumentInput => d !== null);
  return { votes: votos.length, docs };
}

/** Discursos do parlamentar na janela [a, b] (só a lista; o texto vem em speechDocument). */
export async function speechList(codigo: number, a: string, b: string): Promise<DiscursoResumo[]> {
  const qs = new URLSearchParams({ dataInicio: compactDate(a), dataFim: compactDate(b) });
  return parseDiscursos(await fetchJson(`${SENADO_BASE}/senador/${codigo}/discursos.json?${qs}`)).filter(
    (d) => d.url && /^https?:\/\//.test(d.url),
  );
}

/** Texto integral de um discurso → documento L3 (null se curto demais). */
export async function speechDocument(d: DiscursoResumo, person: string = SENADO_PERSON): Promise<DocumentInput | null> {
  const texto = cleanText(
    await fetchText(`${SENADO_BASE}/discurso/texto-integral/${d.codigo}`, { headers: { Accept: "text/plain, application/json" } }),
  );
  if (texto.length < 200) return null;
  return {
    url: d.url!,
    title: `${person} — discurso no Senado${d.data ? ` (${d.data})` : ""}${d.resumo ? `: ${d.resumo.slice(0, 120)}` : ""}`,
    doc_type: "discurso",
    person,
    source_name: "Senado Federal — dados abertos",
    tier: 1,
    published_at: d.data ? `${d.data.slice(0, 10)}T00:00:00Z` : null,
    topics: detectTopics(d.resumo, texto.slice(0, 5000)).slice(0, 3),
    body: texto,
  };
}

export async function runSenado(ctx: Ctx, opts: SenadoOpts): Promise<void> {
  const person = SENADO_PERSON;
  const codigo = opts.codigo ?? (await resolveCodigo(ctx, opts.nome ?? person));
  // Ajustável por --since.
  const since = opts.since ?? SENADO_SINCE;
  const until = opts.until ?? new Date().toISOString().slice(0, 10);

  const docs: DocumentInput[] = [];
  for (const [a, b] of yearWindows(since, until)) {
    const { votes, docs: ds } = await votesDocuments(codigo, a, b, person);
    ctx.log(`votações ${a}..${b}: ${votes} (${ds.length} viram documento)`);
    docs.push(...ds);
  }

  if (opts.discursos) {
    for (const [a, b] of yearWindows(since, until)) {
      const lista = await speechList(codigo, a, b);
      ctx.log(`discursos ${a}..${b}: ${lista.length}`);
      for (const d of lista) {
        try {
          const doc = await speechDocument(d, person);
          if (doc) docs.push(doc);
        } catch (e) {
          ctx.warn(`discurso ${d.codigo}: ${(e as Error).message}`);
        }
      }
    }
  }

  const selected = opts.limit ? docs.slice(0, opts.limit) : docs;
  const result: Record<string, number> = {};
  for (const d of selected) {
    try {
      const r = await ingestDocument(ctx, d, { skipEmbed: opts.skipEmbed });
      result[r] = (result[r] ?? 0) + 1;
    } catch (e) {
      result.erro = (result.erro ?? 0) + 1;
      ctx.warn((e as Error).message);
    }
  }
  ctx.log(`senado: ${JSON.stringify(result)}`);
}
