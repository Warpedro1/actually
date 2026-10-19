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

async function resolveCodigo(ctx: Ctx, nome: string): Promise<number> {
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

export async function runSenado(ctx: Ctx, opts: SenadoOpts): Promise<void> {
  const person: Person = "Flávio Bolsonaro";
  const codigo = opts.codigo ?? (await resolveCodigo(ctx, opts.nome ?? person));
  // 2019-02-01: posse da 56ª legislatura (início do mandato de senador). Ajustável por --since.
  const since = opts.since ?? "2019-02-01";
  const until = opts.until ?? new Date().toISOString().slice(0, 10);

  const docs: DocumentInput[] = [];
  for (const [a, b] of yearWindows(since, until)) {
    const qs = new URLSearchParams({ codigoParlamentar: String(codigo), dataInicio: a, dataFim: b });
    const votos = parseVotacoes(await fetchJson(`${SENADO_BASE}/votacao.json?${qs}`, { timeoutMs: 60_000 }), codigo);
    const ds = votos.map((v) => votacaoToDocument(v, person)).filter((d): d is DocumentInput => d !== null);
    ctx.log(`votações ${a}..${b}: ${votos.length} (${ds.length} viram documento)`);
    docs.push(...ds);
  }

  if (opts.discursos) {
    for (const [a, b] of yearWindows(since, until)) {
      const qs = new URLSearchParams({ dataInicio: compactDate(a), dataFim: compactDate(b) });
      const lista = parseDiscursos(await fetchJson(`${SENADO_BASE}/senador/${codigo}/discursos.json?${qs}`));
      ctx.log(`discursos ${a}..${b}: ${lista.length}`);
      for (const d of lista) {
        if (!d.url || !/^https?:\/\//.test(d.url)) continue;
        let texto: string;
        try {
          texto = cleanText(
            await fetchText(`${SENADO_BASE}/discurso/texto-integral/${d.codigo}`, { headers: { Accept: "text/plain, application/json" } }),
          );
        } catch (e) {
          ctx.warn(`discurso ${d.codigo}: ${(e as Error).message}`);
          continue;
        }
        if (texto.length < 200) continue;
        docs.push({
          url: d.url,
          title: `${person} — discurso no Senado${d.data ? ` (${d.data})` : ""}${d.resumo ? `: ${d.resumo.slice(0, 120)}` : ""}`,
          doc_type: "discurso",
          person,
          source_name: "Senado Federal — dados abertos",
          tier: 1,
          published_at: d.data ? `${d.data.slice(0, 10)}T00:00:00Z` : null,
          topics: detectTopics(d.resumo, texto.slice(0, 5000)).slice(0, 3),
          body: texto,
        });
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
