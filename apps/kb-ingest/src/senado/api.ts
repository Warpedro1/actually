// Dados abertos do Senado — https://legis.senado.leg.br/dadosabertos
// Endpoints e campos conforme o pacote npm senado-br-mcp@3.21.1 (medidos contra a
// origem em 09/2026); deste ambiente o host está bloqueado pelo proxy.
//   GET /senador/lista/atual.json             → ListaParlamentarEmExercicio.Parlamentares.Parlamentar[]
//   GET /senador/afastados.json               → AfastamentoAtual.Parlamentares.Parlamentar[]
//   GET /votacao.json?codigoParlamentar=&dataInicio=yyyy-MM-dd&dataFim=yyyy-MM-dd
//        → [{codigoSessao, codigoSessaoVotacao, dataSessao, identificacao, sigla, numero, ano,
//            codigoMateria, ementa, descricaoVotacao, resultadoVotacao, totalVotosSim/Nao/Abstencao,
//            votacaoSecreta, votos:[{codigoParlamentar, nomeParlamentar, siglaPartidoParlamentar,
//            siglaUFParlamentar, siglaVotoParlamentar, descricaoVotoParlamentar}]}]
//   GET /senador/{codigo}/discursos.json?dataInicio=yyyyMMdd&dataFim=yyyyMMdd
//        → DiscursosParlamentar.Parlamentar.Pronunciamentos.Pronunciamento[]
//          (sem período a fonte devolve só os últimos 30 dias)
//   GET /discurso/texto-integral/{codigo}     → text/plain (sem sufixo .json; Accept text/plain)
import type { DocumentInput } from "../documents/ingest";
import { detectTopics } from "../lib/classify";
import { normalizeForMatch } from "../lib/text";

export const SENADO_BASE = process.env.SENADO_BASE_URL ?? "https://legis.senado.leg.br/dadosabertos";

const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

export interface Senador {
  codigo: number;
  nome: string;
  nomeCompleto: string;
  partido: string | null;
  uf: string | null;
}

export function parseSenadores(json: unknown): Senador[] {
  const j = json as Record<string, any>;
  const list =
    j?.ListaParlamentarEmExercicio?.Parlamentares?.Parlamentar ??
    j?.ListaParlamentarLegislatura?.Parlamentares?.Parlamentar ??
    j?.AfastamentoAtual?.Parlamentares?.Parlamentar;
  return arr(list).map((p: any) => {
    const id = p.IdentificacaoParlamentar ?? p;
    return {
      codigo: Number(id.CodigoParlamentar),
      nome: String(id.NomeParlamentar ?? ""),
      nomeCompleto: String(id.NomeCompletoParlamentar ?? id.NomeParlamentar ?? ""),
      partido: id.SiglaPartidoParlamentar ?? p.Mandato?.Partido?.SiglaPartido ?? null,
      uf: id.UfParlamentar ?? p.Mandato?.UfParlamentar ?? null,
    };
  });
}

/** Acha o senador pelo nome parlamentar (sem acento/caixa). Nunca adivinha: 0 ou >1 ⇒ null. */
export function findSenador(list: Senador[], name: string): Senador | null {
  const n = normalizeForMatch(name);
  const hits = list.filter((s) => normalizeForMatch(s.nome) === n);
  if (hits.length === 1) return hits[0]!;
  const partial = list.filter((s) => normalizeForMatch(s.nome).includes(n) || normalizeForMatch(s.nomeCompleto).includes(n));
  return partial.length === 1 ? partial[0]! : null;
}

export interface VotoSenador {
  codigoSessao: number | null;
  codigoVotacao: number | null;
  data: string;
  materia: string | null;
  ementa: string | null;
  descricao: string | null;
  resultado: string | null;
  totalSim: number | null;
  totalNao: number | null;
  totalAbstencao: number | null;
  secreta: boolean;
  voto: string | null;
  partido: string | null;
  uf: string | null;
}

const RESULTADO: Record<string, string> = { A: "Aprovada", R: "Rejeitada", P: "Prejudicada" };

export function parseVotacoes(json: unknown, codigoParlamentar: number): VotoSenador[] {
  return arr(json as any[]).map((v: any) => {
    const voto = arr(v.votos).find((x: any) => Number(x.codigoParlamentar) === codigoParlamentar) as any;
    const rc = v.resultadoVotacao == null ? null : String(v.resultadoVotacao).trim();
    return {
      codigoSessao: v.codigoSessao ? Number(v.codigoSessao) : null,
      codigoVotacao: v.codigoSessaoVotacao ? Number(v.codigoSessaoVotacao) : null,
      data: v.dataSessao ? String(v.dataSessao).split("T")[0]! : "",
      materia: v.identificacao || (v.sigla ? `${v.sigla} ${v.numero}/${v.ano}` : null),
      ementa: v.ementa || null,
      descricao: v.descricaoVotacao || null,
      resultado: rc ? RESULTADO[rc.toUpperCase()] ?? rc : null,
      totalSim: v.totalVotosSim ?? null,
      totalNao: v.totalVotosNao ?? null,
      totalAbstencao: v.totalVotosAbstencao ?? null,
      secreta: v.votacaoSecreta === "S",
      voto: voto ? voto.descricaoVotoParlamentar || voto.siglaVotoParlamentar || null : null,
      partido: voto?.siglaPartidoParlamentar ?? null,
      uf: voto?.siglaUFParlamentar ?? null,
    };
  });
}

function brDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Votação → documento L3 (doc_type "votacao"). O corpo é montado só com campos
 * da fonte, em frases fixas, para o pipeline citar literalmente.
 * URL: a consulta da sessão na própria API, com fragmento identificando a votação
 * (kb_documents.url é única; o fragmento não muda o que o servidor devolve).
 */
export function votacaoToDocument(v: VotoSenador, person: string): DocumentInput | null {
  if (!v.codigoSessao || !v.data) return null;
  const placar =
    v.totalSim != null || v.totalNao != null
      ? ` (Sim: ${v.totalSim ?? "?"}; Não: ${v.totalNao ?? "?"}; Abstenção: ${v.totalAbstencao ?? 0})`
      : "";
  const votoTxt = v.secreta
    ? `Votação secreta: o voto individual de ${person} não é divulgado.`
    : v.voto
      ? `Voto de ${person}${v.partido ? ` (${v.partido}${v.uf ? `-${v.uf}` : ""})` : ""}: ${v.voto}.`
      : `Não há registro de voto de ${person} nesta votação.`;
  const lines = [
    `Votação no Plenário do Senado Federal em ${brDate(v.data)}.`,
    v.materia ? `Matéria: ${v.materia}.` : null,
    v.ementa ? `Ementa: ${v.ementa}` : null,
    v.descricao ? `Descrição da votação: ${v.descricao}` : null,
    v.resultado ? `Resultado: ${v.resultado}${placar}.` : null,
    votoTxt,
  ].filter(Boolean) as string[];
  const body = lines.join("\n");
  return {
    url: `${SENADO_BASE}/votacao.json?codigoSessao=${v.codigoSessao}#votacao-${v.codigoVotacao ?? "sessao"}`,
    title: `${person} — voto em ${v.materia ?? "votação"} (${brDate(v.data)})`,
    doc_type: "votacao",
    person,
    source_name: "Senado Federal — dados abertos",
    tier: 1,
    published_at: `${v.data}T00:00:00Z`,
    topics: detectTopics(v.ementa, v.descricao).slice(0, 3),
    body,
  };
}

export interface DiscursoResumo {
  codigo: number;
  data: string | null;
  resumo: string | null;
  tipo: string | null;
  url: string | null;
}

export function parseDiscursos(json: unknown): DiscursoResumo[] {
  const j = json as Record<string, any>;
  const list = j?.DiscursosParlamentar?.Parlamentar?.Pronunciamentos?.Pronunciamento ?? j?.Pronunciamentos?.Pronunciamento;
  return arr(list)
    .map((p: any) => ({
      codigo: Number(p.CodigoPronunciamento),
      data: p.DataPronunciamento ?? null,
      resumo: p.TextoResumo ?? null,
      tipo: p.TipoUsoPalavra?.Descricao ?? null,
      url: p.UrlTexto ?? null,
    }))
    .filter((d) => Number.isFinite(d.codigo) && d.codigo > 0);
}

/** "2024-03-05" → "20240305" (formato dos parâmetros de discursos). */
export function compactDate(iso: string): string {
  return iso.replaceAll("-", "");
}

/** Janelas anuais [ini, fim] entre duas datas ISO. */
export function yearWindows(since: string, until: string): [string, string][] {
  const out: [string, string][] = [];
  for (let y = Number(since.slice(0, 4)); y <= Number(until.slice(0, 4)); y++) {
    const a = y === Number(since.slice(0, 4)) ? since : `${y}-01-01`;
    const b = y === Number(until.slice(0, 4)) ? until : `${y}-12-31`;
    out.push([a, b]);
  }
  return out;
}
