// RF15: a base aprende com a web e com as agências que recusam a Vercel.
// - páginas recusadas no download direto (403) são lidas pela Tavily; robots.txt proibindo, nunca;
// - matéria de agência com várias falas checadas vira documento L3 (sem sobrescrever documento curado);
// - etapa web-finds: fila kb_web_finds → checagem L1 ou documento L3 com origin 'web';
// - etapa factchecks-tavily: busca nas agências sem baixar de novo, filtrando caminho e data.
// Correções da revisão: página de lista nunca vira documento; página pronta da Tavily só com
// robots.txt permitindo; checagem sem data não vira L1; texto da Tavily não substitui documento
// que já está na base; título sem sufixo de data; vários selos diferentes ⇒ sem selo único.
// Sem rede: fetch falso e banco em memória. Pessoas, lugares e números são fictícios.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sem intervalo mínimo entre requisições ao mesmo host (lido quando lib/http é carregado)
vi.hoisted(() => {
  process.env.KB_INGEST_MIN_INTERVAL_MS = "0";
});

import type { KbWebFind } from "@actually/db";
import { runDocuments } from "../src/commands/documents";
import { processCandidates } from "../src/commands/factchecks";
import { fetchDocument } from "../src/documents/fetchDoc";
import { agencyQuery, candidatesFromSearch } from "../src/factchecks/agencySearch";
import {
  cleanPageTitle,
  dateFromText,
  dateFromUrl,
  isListingPage,
  isListingPath,
  mostlyHeadlines,
  pageFromText,
  type FactcheckCandidate,
} from "../src/factchecks/normalize";
import { HttpError } from "../src/lib/http";
import { clearRobotsCache } from "../src/lib/robots";
import { timeRangeSince } from "../src/lib/tavily";
import { drainUsage } from "../src/lib/usage";
import { runStep, type KbStep } from "../src/jobs/steps";
import { FakeDb, testCtx, type Row } from "./fakeDb";

const TAVILY_EXTRACT = "https://api.tavily.com/extract";
const TAVILY_SEARCH = "https://api.tavily.com/search";

const CHECAGEM_TITULO = "É falso que a inflação de Vila Imaginária chegou a 40% em 2030";
const CHECAGEM = [
  CHECAGEM_TITULO,
  "Circula nas redes sociais um vídeo em que o deputado Fulano de Tal afirma que a inflação de Vila Imaginária chegou a 40% em 2030. A informação é falsa.",
  "Segundo os dados do Instituto de Estatística Imaginário, a inflação acumulada em 2030 foi de 4,1%, quase dez vezes menor do que o número citado no vídeo.",
  "O instituto publica o índice todos os meses desde 1995, e a série nunca passou de 12% ao ano no período.",
  "Procurado pela reportagem, o gabinete do deputado não respondeu até a publicação desta checagem.",
  "Classificação: Falso",
  "Leia também:",
  "Outra checagem sobre a ponte de Vila Imaginária",
].join("\n");

const MATERIA_VARIAS_FALAS = [
  "Checamos o debate de Vila Imaginária",
  "A Agência Exemplo acompanhou o debate entre os candidatos Fulano de Tal e Beltrano da Silva e checou as principais falas sobre economia.",
  "“A inflação dobrou no último ano” — Fulano de Tal",
  "FALSO",
  "Os dados do Instituto de Estatística Imaginário mostram que a inflação passou de 4,1% para 4,6% entre 2029 e 2030, alta bem menor do que a citada.",
  "“O desemprego é o menor da história” — Beltrano da Silva",
  "EXAGERADO",
  "A taxa de desocupação de 2030 ficou em 7,2%, mas em 2014 ela chegou a 6,8%, segundo a série histórica do instituto.",
].join("\n");

const NOTICIA = [
  "Prefeitura de Vila Imaginária anuncia ponte nova",
  "A prefeitura de Vila Imaginária anunciou nesta segunda-feira a construção de uma ponte sobre o rio Fictício, com custo estimado de R$ 412 milhões.",
  "Segundo o edital, a obra deve começar no segundo semestre e levar três anos. O dinheiro virá do orçamento municipal e de um empréstimo federal.",
  "Moradores da região reclamam há anos do trânsito na ponte antiga, construída na década de 1970 e interditada duas vezes por problemas na estrutura.",
  "A oposição na Câmara Municipal pediu a íntegra dos estudos de viabilidade antes da votação do orçamento.",
].join("\n");

/** Página de lista de uma agência (home/seção): só manchetes de outras checagens e datas. */
const LISTA = [
  "Notícias",
  "É falso que a inflação de Vila Imaginária chegou a 40% em 2030",
  "14.mar.2030",
  "Vídeo de ponte desabando em Vila Imaginária é montagem",
  "13.mar.2030",
  "Desemprego em Vila Imaginária: o que dizem os dados do instituto",
  "12.mar.2030",
  "Checamos o debate de Vila Imaginária: inflação e desemprego",
  "11.mar.2030",
  "Prefeito de Vila Imaginária exagera ao falar do custo da ponte nova",
  "10.mar.2030",
  "Post engana ao dizer que o salário mínimo de Vila Imaginária caiu",
  "09.mar.2030",
  "Deputado distorce dado de emprego em Vila Imaginária",
  "Mais checagens sobre a eleição em Vila Imaginária",
].join("\n");

/** Matéria com duas falas, cada uma com o seu rótulo, sem selo único; data só no texto. */
const DUAS_FALAS = [
  "Checamos as falas do prefeito de Vila Imaginária sobre a economia",
  "Por Agência Exemplo",
  "Publicado em 15 de março de 2030, às 18h",
  "O prefeito Fulano de Tal deu entrevista nesta sexta-feira e falou sobre inflação e desemprego em Vila Imaginária. A reportagem checou duas falas.",
  "“A inflação dobrou no último ano”",
  "Os dados do Instituto de Estatística Imaginário mostram que a inflação passou de 4,1% para 4,6% entre 2029 e 2030, alta bem menor do que a citada.",
  "Classificação: Falso",
  "“O desemprego é o menor da história”",
  "A taxa de desocupação de 2030 ficou em 7,2%, mas em 2014 ela chegou a 6,8%, segundo a série histórica do instituto.",
  "Classificação: Exagerado",
].join("\n");

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** fetch falso: rota por URL exata; o resto (robots.txt incluído) responde 404. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    return route ? route(init) : new Response("não encontrado", { status: 404 });
  });
  return calls;
}

const jsonBody = (init?: RequestInit) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
const tavilyCalls = <C extends { url: string }>(calls: C[]) => calls.filter((c) => c.url.startsWith("https://api.tavily.com/"));

beforeEach(() => {
  vi.stubEnv("TAVILY_API_KEY", "tvly-teste");
  vi.stubEnv("VOYAGE_API_KEY", "");
  drainUsage();
  // sem rede: todo teste começa com fetch falso (tudo 404, robots.txt incluído) e sem robots.txt guardado
  clearRobotsCache();
  fakeFetch({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("[RF15] texto vindo da Tavily", () => {
  it("[RF15] data no caminho da URL, título sem o nome do site e mesma limpeza do HTML", () => {
    expect(dateFromUrl("https://g1.globo.com/fato-ou-fake/noticia/2026/10/20/e-fake.ghtml")).toBe("2026-10-20");
    expect(dateFromUrl("https://lupa.uol.com.br/jornalismo/2026/10/20/checamos")).toBe("2026-10-20");
    expect(dateFromUrl("https://exemplo.org/arquivo/2026/10/20")).toBe(null); // sem barra depois do dia
    expect(dateFromUrl("https://exemplo.org/2026/02/31/x")).toBe(null);
    expect(dateFromUrl("https://aosfatos.org/noticias/checamos/")).toBe(null);

    const g1 = "https://g1.globo.com/fato-ou-fake/noticia/x.ghtml";
    expect(cleanPageTitle("É #FAKE que a ponte caiu ontem | Fato ou Fake | g1", g1)).toBe("É #FAKE que a ponte caiu ontem");
    expect(cleanPageTitle("Checamos o debate de ontem - Aos Fatos", "https://aosfatos.org/noticias/x/")).toBe("Checamos o debate de ontem");
    // hífen que não separa o nome do site fica
    expect(cleanPageTitle("Inflação sobe em março - entenda", "https://aosfatos.org/x/")).toBe("Inflação sobe em março - entenda");
    expect(cleanPageTitle("  ", g1)).toBeNull();

    const page = pageFromText({ url: "https://lupa.uol.com.br/jornalismo/2030/03/14/x", title: null, text: CHECAGEM });
    expect(page.text).not.toContain("Leia também");
    expect(page.text).not.toContain("Outra checagem sobre a ponte");
    expect(page).toMatchObject({ publishedAt: "2030-03-14", claimReviews: [] });
  });

  it("[RF15] janela da busca cobre o `since` (o corte exato é feito depois)", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(timeRangeSince("2026-10-18", now)).toBe("week");
    expect(timeRangeSince("2026-10-01", now)).toBe("month");
    expect(timeRangeSince("2026-09-06", now)).toBe("year");
    expect(timeRangeSince("2020-01-01", now)).toBeUndefined();
  });
});

describe("[RF15] download recusado: fallback da Tavily", () => {
  it("[RF15] 403 no download direto ⇒ lê pela Tavily, limpa o texto e grava a checagem; conta 0,2 crédito", async () => {
    const url = "https://checagem-bloqueada.test/2030/03/14/inflacao-vila-imaginaria";
    const calls = fakeFetch({
      [url]: () => new Response("Access Denied", { status: 403 }),
      [TAVILY_EXTRACT]: () => Response.json({ results: [{ url, raw_content: CHECAGEM }], failed_results: [] }),
    });
    const db = new FakeDb();
    const { ctx, logs } = testCtx(db);
    await processCandidates(ctx, [{ url, title: CHECAGEM_TITULO }], {});

    const extract = tavilyCalls(calls);
    expect(extract).toHaveLength(1);
    expect(jsonBody(extract[0]!.init)).toEqual({ urls: [url], extract_depth: "basic", format: "text" });
    expect((extract[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer tvly-teste");

    const rows = db.rows("kb_factchecks");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url, verdict: "contradito", published_at: "2030-03-14T00:00:00.000Z" });
    const body = String(rows[0]!.body);
    expect(body).not.toContain("Leia também");
    expect(body.includes(String(rows[0]!.quote))).toBe(true);
    expect(logs.join("\n")).toMatch(/1 páginas lidas pela Tavily/);
    expect(drainUsage()).toEqual([{ provider: "tavily", model: "extract", requests: 1, units: 0.2 }]);
  });

  it("[RF15] robots.txt proibindo ⇒ descarta sem chamar a Tavily; 404 também não chama", async () => {
    const proibida = "https://robo-proibe.test/checagens/inflacao";
    const sumiu = "https://pagina-sumiu.test/checagens/inflacao";
    const calls = fakeFetch({
      "https://robo-proibe.test/robots.txt": () => new Response("User-agent: *\nDisallow: /checagens/\n"),
      [TAVILY_EXTRACT]: () => Response.json({ results: [{ url: proibida, raw_content: CHECAGEM }] }),
    });
    const db = new FakeDb();
    const { ctx, logs } = testCtx(db);
    await processCandidates(ctx, [{ url: proibida, title: CHECAGEM_TITULO }, { url: sumiu, title: CHECAGEM_TITULO }], {});

    expect(tavilyCalls(calls)).toEqual([]);
    expect(calls.some((c) => c.url === proibida)).toBe(false);
    expect(db.rows("kb_factchecks")).toEqual([]);
    const summary = logs.find((l) => l.startsWith("checagens aproveitadas"))!;
    expect(summary).toContain('"robots_txt":1');
    expect(summary).toContain('"download_falhou":1');
  });

  it("[RF15] Tavily também não lê (failed_results) ⇒ download_falhou, com um aviso só", async () => {
    const urls = ["https://bloqueia-tudo.test/a", "https://bloqueia-tudo.test/b"];
    fakeFetch({
      [urls[0]!]: () => new Response("Access Denied", { status: 403 }),
      [urls[1]!]: () => new Response("Access Denied", { status: 403 }),
      [TAVILY_EXTRACT]: (init) => Response.json({ results: [], failed_results: [{ url: (jsonBody(init).urls as string[])[0], error: "blocked" }] }),
    });
    const { ctx, logs, warns } = testCtx(new FakeDb());
    await processCandidates(ctx, urls.map((url) => ({ url, title: CHECAGEM_TITULO })), {});
    expect(logs.find((l) => l.startsWith("checagens aproveitadas"))).toContain('"download_falhou":2');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/Tavily não leu 2 páginas.*blocked/);
  });

  it("[RF15] documento HTML recusado vem pela Tavily; PDF recusado continua erro", async () => {
    const html = "https://doc-bloqueado.test/2030/03/14/programa";
    const pdf = "https://doc-bloqueado.test/programa.pdf";
    const calls = fakeFetch({
      [html]: () => new Response("Access Denied", { status: 403 }),
      [pdf]: () => new Response("Access Denied", { status: 403 }),
      [TAVILY_EXTRACT]: () => Response.json({ results: [{ url: html, title: "Programa de governo", raw_content: `${NOTICIA}\nLeia mais:\nOutra notícia de Vila Imaginária` }] }),
    });
    const doc = await fetchDocument(html);
    expect(doc).toMatchObject({ format: "html", via: "tavily", title: "Programa de governo", publishedAt: "2030-03-14" });
    expect(doc.text).toContain("rio Fictício");
    expect(doc.text).not.toContain("Leia mais");

    await expect(fetchDocument(pdf)).rejects.toBeInstanceOf(HttpError);
    expect(tavilyCalls(calls)).toHaveLength(1);
  });
});

describe("[RF15] matéria de agência com várias falas", () => {
  it("[RF15] vira documento L3 da agência; não sobrescreve documento que já existe; fora de agência continua descarte", async () => {
    const lupa = "https://lupa.uol.com.br/jornalismo/2030/03/15/checamos-o-debate-de-vila-imaginaria";
    const aosFatos = "https://aosfatos.org/noticias/checamos-a-sabatina-de-vila-imaginaria";
    const jornal = "https://jornal-qualquer.test/2030/03/15/debate";
    const curado: Row = { id: "doc-curado", url: aosFatos, title: "Curado à mão", body: "texto revisado pela equipe", doc_type: "noticia" };
    const db = new FakeDb({ kb_documents: [curado] });
    const calls = fakeFetch({});
    const { ctx, logs } = testCtx(db);
    const withPage = (url: string): FactcheckCandidate => ({
      url,
      page: pageFromText({ url, title: "Checamos o debate de Vila Imaginária: inflação e desemprego", text: MATERIA_VARIAS_FALAS }),
    });
    await processCandidates(ctx, [withPage(lupa), withPage(aosFatos), withPage(jornal)], {});

    // página já obtida (busca): nada é baixado; só o robots.txt de cada origem é consultado
    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://aosfatos.org/robots.txt",
      "https://jornal-qualquer.test/robots.txt",
      "https://lupa.uol.com.br/robots.txt",
    ]);
    expect(db.rows("kb_factchecks")).toEqual([]);
    const docs = db.rows("kb_documents");
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.url === aosFatos)).toEqual(curado);
    const doc = docs.find((d) => d.url === lupa)!;
    expect(doc).toMatchObject({
      doc_type: "noticia",
      source_name: "Agência Lupa",
      tier: 1,
      person: null,
      published_at: "2030-03-15T00:00:00.000Z",
      title: "Checamos o debate de Vila Imaginária: inflação e desemprego",
    });
    expect(doc.topics).toContain("economia");
    expect(doc.origin).toBeUndefined();
    expect(db.rows("kb_chunks").length).toBeGreaterThan(0);
    const summary = logs.find((l) => l.startsWith("checagens aproveitadas"))!;
    expect(summary).toContain('"virou_documento":1');
    expect(summary).toContain('"ja_na_base":1');
    expect(summary).toContain('"sem_rating":1');
  });
});

// --- fila kb_web_finds ------------------------------------------------------------

let findSeq = 0;
function find(url: string, text: string, extra: Partial<KbWebFind> = {}): KbWebFind {
  findSeq++;
  return {
    id: `w${findSeq}`,
    url,
    title: "",
    text,
    source_name: "Fonte",
    tier: 1,
    published_at: null,
    query: "inflação de Vila Imaginária",
    debate_id: null,
    found_at: new Date(Date.UTC(2030, 2, 20, 0, findSeq)).toISOString(),
    status: "pending",
    claimed_at: null,
    processed_at: null,
    note: null,
    ...extra,
  };
}

/** kb_web_finds_claim: até p_limit pendentes, em ordem, marcadas "processing". */
function webFindsDb(finds: KbWebFind[], init: Record<string, Row[]> = {}): FakeDb {
  const db = new FakeDb({ ...init, kb_web_finds: finds as unknown as Row[] });
  db.rpcs.kb_web_finds_claim = ({ p_limit }, d) => {
    const got = d.rows("kb_web_finds").filter((r) => r.status === "pending").slice(0, Number(p_limit));
    for (const r of got) Object.assign(r, { status: "processing", claimed_at: "2030-03-20T12:00:00Z" });
    return got.map((r) => ({ ...r }));
  };
  return db;
}

async function drain(ctx: ReturnType<typeof testCtx>["ctx"], first: KbStep, deadline = Date.now() + 60_000): Promise<number> {
  let queue = [first];
  let n = 0;
  while (queue.length) {
    const step = queue.shift()!;
    queue = [...(await runStep(ctx, step, { deadline })), ...queue];
    n++;
  }
  return n;
}

describe("[RF15] etapa web-finds (a base aprende com a web)", () => {
  it("[RF15] checagem com selo ⇒ L1, matéria comum ⇒ documento, ambos com origin web; já na base e texto ruim ⇒ skipped", async () => {
    const g1 = "https://g1.globo.com/fato-ou-fake/noticia/2030/03/14/e-falso-que-a-inflacao-chegou-a-40.ghtml";
    const folha = "https://www1.folha.uol.com.br/cotidiano/2030/03/ponte-nova.shtml?utm_source=x";
    const jaNaBase = "https://www1.folha.uol.com.br/cotidiano/2030/03/ja-na-base.shtml";
    const finds = [
      find(g1, CHECAGEM, { title: `${CHECAGEM_TITULO} | Fato ou Fake | g1`, source_name: "Fato ou Fake (g1)" }),
      find(folha, NOTICIA, { title: "Prefeitura anuncia ponte nova em Vila Imaginária - Folha de S.Paulo", source_name: "Folha de S.Paulo", tier: 2 }),
      find(jaNaBase, NOTICIA, { source_name: "Folha de S.Paulo", tier: 2 }),
      find("https://www1.folha.uol.com.br/curta.shtml", "Assine a Folha para continuar lendo esta reportagem.", { tier: 2 }),
      find("https://www1.folha.uol.com.br/sem-acento.shtml", "Compete a Uniao estabelecer a Politica Nacional de Vila Imaginaria. ".repeat(12), { tier: 2 }),
    ];
    const db = webFindsDb(finds, { kb_documents: [{ id: "d0", url: jaNaBase, title: "x", body: "x" }] });
    const { ctx } = testCtx(db);
    await drain(ctx, { kind: "web-finds", limit: 10 });

    const fc = db.rows("kb_factchecks");
    expect(fc).toHaveLength(1);
    expect(fc[0]).toMatchObject({
      url: g1,
      origin: "web",
      source_name: "Fato ou Fake (g1)",
      verdict: "contradito",
      claim_text: "A inflação de Vila Imaginária chegou a 40% em 2030",
      published_at: "2030-03-14T00:00:00.000Z",
    });
    const doc = db.rows("kb_documents").find((d) => String(d.url).includes("ponte-nova"))!;
    expect(doc).toMatchObject({
      url: "https://www1.folha.uol.com.br/cotidiano/2030/03/ponte-nova.shtml",
      origin: "web",
      doc_type: "noticia",
      tier: 2,
      source_name: "Folha de S.Paulo",
      title: "Prefeitura anuncia ponte nova em Vila Imaginária",
    });
    expect(db.rows("kb_chunks").some((c) => c.document_id === doc.id)).toBe(true);

    const status = Object.fromEntries(db.rows("kb_web_finds").map((r) => [r.url, [r.status, r.note]]));
    expect(status).toEqual({
      [g1]: ["done", "checagem"],
      [folha]: ["done", "documento"],
      [jaNaBase]: ["skipped", "ja_na_base"],
      "https://www1.folha.uol.com.br/curta.shtml": ["skipped", "texto_curto"],
      "https://www1.folha.uol.com.br/sem-acento.shtml": ["skipped", "sem_acento"],
    });
    expect(db.rows("kb_web_finds").every((r) => typeof r.processed_at === "string")).toBe(true);
  });

  it("[RF15] erro numa página marca failed com a mensagem e as outras seguem; continua enquanto a RPC devolve linhas", async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://www1.folha.uol.com.br/cotidiano/2030/03/materia-${i}.shtml`);
    const db = webFindsDb(urls.map((u) => find(u, `${NOTICIA}\n${u}`, { title: "Matéria", source_name: "Folha de S.Paulo", tier: 2 })));
    db.failOn = (table, op, row) => (table === "kb_documents" && op === "upsert" && row.url === urls[1] ? "falha simulada no banco" : null);
    const { ctx, warns } = testCtx(db);
    const steps = await drain(ctx, { kind: "web-finds", limit: 3 });

    // 3 + 3 + 1 páginas e uma rodada que acha a fila vazia
    expect(steps).toBe(4);
    expect(db.rpcCalls.map((c) => c.args)).toEqual([{ p_limit: 3 }, { p_limit: 3 }, { p_limit: 3 }, { p_limit: 3 }]);
    const byUrl = new Map(db.rows("kb_web_finds").map((r) => [r.url, r]));
    expect(byUrl.get(urls[1])).toMatchObject({ status: "failed", note: expect.stringMatching(/falha simulada no banco/) });
    expect(urls.filter((u) => byUrl.get(u)!.status === "done")).toHaveLength(6);
    expect(db.rows("kb_documents")).toHaveLength(6);
    expect(warns.join("\n")).toMatch(/falha simulada/);
  });

  it("[RF15] prazo esgotado: as páginas pegas voltam para a fila na hora; fila vazia ⇒ sem continuação", async () => {
    const db = webFindsDb([find("https://www1.folha.uol.com.br/a.shtml", NOTICIA), find("https://www1.folha.uol.com.br/b.shtml", NOTICIA)]);
    const { ctx } = testCtx(db);
    const more = await runStep(ctx, { kind: "web-finds", limit: 10 }, { deadline: Date.now() - 1 });
    expect(more).toEqual([{ kind: "web-finds", limit: 10 }]);
    expect(db.rows("kb_web_finds").map((r) => [r.status, r.claimed_at])).toEqual([
      ["pending", null],
      ["pending", null],
    ]);
    expect(db.rows("kb_documents")).toEqual([]);

    const empty = webFindsDb([]);
    expect(await runStep(testCtx(empty).ctx, { kind: "web-finds", limit: 10 }, { deadline: Date.now() + 60_000 })).toEqual([]);
  });
});

describe("[RF15] etapa factchecks-tavily (checagens recentes das agências)", () => {
  it("[RF15] consulta no host da agência com o nome da seção; só caminho de agência e data desde `since`", () => {
    expect(agencyQuery("g1.globo.com/fato-ou-fake", "Lula")).toBe("Fato ou Fake Lula");
    expect(agencyQuery("noticias.uol.com.br/confere", "debate")).toBe("UOL Confere debate");
    expect(agencyQuery("aosfatos.org", "Lula")).toBe("Lula");

    const r = (url: string, published_date: string | null = null) => ({ url, title: "t", raw_content: CHECAGEM, published_date });
    const { candidates, dropped } = candidatesFromSearch(
      [
        r("https://noticias.uol.com.br/confere/ultimas-noticias/2030/03/14/e-falso.htm"),
        r("https://noticias.uol.com.br/politica/ultimas-noticias/2030/03/14/debate.htm"),
        r("https://checamos.afp.com/doc.afp.com.ABC123", "2029-12-01"),
        r("https://checamos.afp.com/doc.afp.com.DEF456"),
      ],
      "2030-02-01",
    );
    expect(candidates.map((c) => c.url)).toEqual(["https://noticias.uol.com.br/confere/ultimas-noticias/2030/03/14/e-falso.htm"]);
    expect(candidates[0]).toMatchObject({ publishedAt: "2030-03-14", page: { publishedAt: "2030-03-14", claimReviews: [] } });
    // sem data na URL, no buscador nem no texto: fica de fora
    expect(dropped).toEqual({ fora_da_agencia: 1, antiga: 1, sem_data: 1 });
  });

  it("[RF15] busca uma vez, não baixa as páginas: checagem com selo ⇒ L1, matéria com várias falas ⇒ documento, já na base ⇒ pula", async () => {
    const base = "https://g1.globo.com/fato-ou-fake/noticia";
    const selo = `${base}/2030/03/14/e-falso-que-a-inflacao-chegou-a-40.ghtml`;
    const varias = `${base}/2030/03/14/checamos-a-sabatina-de-vila-imaginaria.ghtml`;
    const jaNaBase = `${base}/2030/03/14/ja-checada.ghtml`;
    const results = [
      { url: selo, title: `${CHECAGEM_TITULO} | Fato ou Fake | g1`, raw_content: CHECAGEM, published_date: null },
      { url: `https://g1.globo.com/politica/noticia/2030/03/14/debate.ghtml`, title: "Debate", raw_content: NOTICIA },
      { url: `${base}/2029/01/10/antiga.ghtml`, title: CHECAGEM_TITULO, raw_content: CHECAGEM },
      { url: varias, title: "Checamos a sabatina de Vila Imaginária | Fato ou Fake | g1", raw_content: MATERIA_VARIAS_FALAS },
      { url: jaNaBase, title: CHECAGEM_TITULO, raw_content: CHECAGEM },
    ];
    const calls = fakeFetch({ [TAVILY_SEARCH]: () => Response.json({ results }) });
    const antiga = { id: "fc0", url: jaNaBase, claim_text: "checagem antiga", verdict: "contradito" };
    const db = new FakeDb({ kb_factchecks: [antiga] });
    const { ctx, logs } = testCtx(db);
    const more = await runStep(
      ctx,
      { kind: "factchecks-tavily", domain: "g1.globo.com/fato-ou-fake", query: "Lula", since: "2030-02-01" },
      { deadline: Date.now() + 60_000, now: () => Date.parse("2030-03-20T12:00:00Z") },
    );

    expect(more).toEqual([]);
    // a página veio na busca: só o robots.txt (uma vez por origem) antes de usá-la
    expect(calls.map((c) => c.url)).toEqual([TAVILY_SEARCH, "https://g1.globo.com/robots.txt"]);
    expect(jsonBody(calls[0]!.init)).toMatchObject({
      query: "Fato ou Fake Lula",
      include_domains: ["g1.globo.com"],
      include_raw_content: "text",
      search_depth: "basic",
      time_range: "year",
    });
    expect(db.rows("kb_factchecks")).toHaveLength(2);
    expect(db.rows("kb_factchecks").find((r) => r.url === jaNaBase)).toEqual(antiga);
    expect(db.rows("kb_factchecks").find((r) => r.url === selo)).toMatchObject({
      source_name: "Fato ou Fake (g1)",
      claim_text: "A inflação de Vila Imaginária chegou a 40% em 2030",
      published_at: "2030-03-14T00:00:00.000Z",
    });
    expect(db.rows("kb_documents").map((d) => [d.url, d.title, d.tier])).toEqual([[varias, "Checamos a sabatina de Vila Imaginária", 1]]);
    expect(logs.join("\n")).toMatch(/5 resultados, 3 páginas de checagem .*"fora_da_agencia":1.*"antiga":1/);
    expect(drainUsage()).toEqual([{ provider: "tavily", model: "search", requests: 1, units: 1 }]);
  });

  it("[RF15] sem TAVILY_API_KEY a etapa não chama a API e não grava nada", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    const calls = fakeFetch({});
    const { ctx, warns } = testCtx(new FakeDb());
    const more = await runStep(ctx, { kind: "factchecks-tavily", domain: "aosfatos.org", query: "Lula", since: "2030-02-01" }, { deadline: Date.now() + 60_000 });
    expect(more).toEqual([]);
    expect(calls).toEqual([]);
    expect(warns.join(" ")).toMatch(/TAVILY_API_KEY ausente/);
  });
});

// --- correções da revisão adversarial ---------------------------------------------

const withPage = (url: string, title: string, text: string, publishedAt: string | null = null): FactcheckCandidate => ({
  url,
  publishedAt,
  page: pageFromText({ url, title, text, publishedAt }),
});
const summaryOf = (logs: string[]) => logs.find((l) => l.startsWith("checagens aproveitadas"))!;

describe("[RF15] página de lista (home, seção, tag) nunca vira documento", () => {
  it("[RF15] caminho de índice e texto só de manchetes", () => {
    for (const url of [
      "https://www.aosfatos.org/noticias/",
      "https://g1.globo.com/fato-ou-fake/",
      "https://www1.folha.uol.com.br/poder/",
      "https://aosfatos.org/",
      "https://noticias.uol.com.br/confere/ultimas-noticias/",
      "https://aosfatos.org/tag/eleicoes/",
      "https://lupa.uol.com.br/autor/fulano-de-tal",
      "https://www.estadao.com.br/estadao-verifica/categoria/politica/",
      "https://lupa.uol.com.br/jornalismo/page/2",
      // a própria seção da agência em SOURCE_TIERS, mesmo com dois segmentos
      "https://noticias.uol.com.br/confere",
    ]) {
      expect(isListingPath(url), url).toBe(true);
    }
    for (const url of [
      "https://checamos.afp.com/doc.afp.com.36YL8ZA",
      "https://aosfatos.org/noticias/checamos-a-sabatina-de-vila-imaginaria/",
      "https://lupa.uol.com.br/jornalismo/2030/03/15/checamos-o-debate",
      "https://www1.folha.uol.com.br/a.shtml",
      "https://exemplo.org/e-falso-que-a-ponte-caiu-ontem",
      "https://noticias.uol.com.br/confere/ultimas-noticias/2030/03/14/e-falso.htm",
    ]) {
      expect(isListingPath(url), url).toBe(false);
    }
    expect(mostlyHeadlines(LISTA)).toBe(true);
    // selos, falas citadas, data e assinatura não contam: matéria com várias falas não é lista
    for (const text of [CHECAGEM, NOTICIA, MATERIA_VARIAS_FALAS, DUAS_FALAS]) expect(mostlyHeadlines(text)).toBe(false);
    expect(isListingPage("https://lupa.uol.com.br/jornalismo/2030/03/15/especial", LISTA)).toBe(true);
  });

  it("[RF15] matéria de agência: home, seção e página de manchetes contam como lista; nada é gravado", async () => {
    const db = new FakeDb();
    const { ctx, logs } = testCtx(db);
    await processCandidates(
      ctx,
      [
        withPage("https://www.aosfatos.org/noticias/", "Notícias | Aos Fatos", LISTA),
        withPage("https://g1.globo.com/fato-ou-fake/", "Fato ou Fake | g1", LISTA),
        // caminho de matéria, texto de lista
        withPage("https://lupa.uol.com.br/jornalismo/2030/03/15/especial-vila-imaginaria", "Especial: Vila Imaginária", LISTA),
        // caminho de lista, texto de matéria
        withPage("https://aosfatos.org/tag/vila-imaginaria/", "Vila Imaginária | Aos Fatos", MATERIA_VARIAS_FALAS),
      ],
      {},
    );
    expect(db.rows("kb_documents")).toEqual([]);
    expect(db.rows("kb_factchecks")).toEqual([]);
    expect(summaryOf(logs)).toContain('"lista":4');
  });

  it("[RF15] web-finds: página de lista ⇒ skipped/lista; matéria comum segue virando documento", async () => {
    const artigo = "https://www1.folha.uol.com.br/cotidiano/2030/03/ponte-nova.shtml";
    const finds = [
      find("https://www.aosfatos.org/noticias/", LISTA, { title: "Notícias | Aos Fatos", source_name: "Aos Fatos" }),
      find("https://www1.folha.uol.com.br/poder/", NOTICIA, { title: "Poder - Folha", source_name: "Folha de S.Paulo", tier: 2 }),
      find("https://www1.folha.uol.com.br/poder/2030/03/especial-eleicoes.shtml", LISTA, { source_name: "Folha de S.Paulo", tier: 2 }),
      find(artigo, NOTICIA, { title: "Prefeitura anuncia ponte nova", source_name: "Folha de S.Paulo", tier: 2 }),
    ];
    const db = webFindsDb(finds);
    await drain(testCtx(db).ctx, { kind: "web-finds", limit: 10 });
    expect(Object.fromEntries(db.rows("kb_web_finds").map((r) => [r.url, [r.status, r.note]]))).toEqual({
      "https://www.aosfatos.org/noticias/": ["skipped", "lista"],
      "https://www1.folha.uol.com.br/poder/": ["skipped", "lista"],
      "https://www1.folha.uol.com.br/poder/2030/03/especial-eleicoes.shtml": ["skipped", "lista"],
      [artigo]: ["done", "documento"],
    });
    expect(db.rows("kb_documents").map((d) => d.url)).toEqual([artigo]);
  });
});

describe("[RF15] robots.txt também vale para a página que veio pronta da Tavily", () => {
  it("[RF15] processCandidates: robots.txt \"Disallow: /\" ou com erro (503) ⇒ robots_txt, sem gravar e sem Tavily", async () => {
    const calls = fakeFetch({
      "https://aosfatos.org/robots.txt": () => new Response("User-agent: *\nDisallow: /\n"),
      "https://lupa.uol.com.br/robots.txt": () => new Response("fora do ar", { status: 503 }),
    });
    const db = new FakeDb();
    const { ctx, logs } = testCtx(db);
    await processCandidates(
      ctx,
      [
        withPage("https://aosfatos.org/noticias/e-falso-que-a-inflacao-chegou-a-40", CHECAGEM_TITULO, CHECAGEM, "2030-03-14"),
        withPage("https://lupa.uol.com.br/jornalismo/2030/03/15/checamos-o-debate", "Checamos o debate", MATERIA_VARIAS_FALAS),
      ],
      {},
    );
    expect(db.rows("kb_factchecks")).toEqual([]);
    expect(db.rows("kb_documents")).toEqual([]);
    expect(summaryOf(logs)).toContain('"robots_txt":2');
    expect(tavilyCalls(calls)).toEqual([]);
  });

  it("[RF15] etapa factchecks-tavily: agência com \"Disallow: /\" ⇒ nada gravado", async () => {
    const url = "https://aosfatos.org/noticias/e-falso-que-a-inflacao-chegou-a-40";
    fakeFetch({
      [TAVILY_SEARCH]: () => Response.json({ results: [{ url, title: `${CHECAGEM_TITULO} - Aos Fatos`, raw_content: CHECAGEM, published_date: "2030-03-14" }] }),
      "https://aosfatos.org/robots.txt": () => new Response("User-agent: *\nDisallow: /\n"),
    });
    const db = new FakeDb();
    const { ctx, logs } = testCtx(db);
    await runStep(ctx, { kind: "factchecks-tavily", domain: "aosfatos.org", query: "Lula", since: "2030-02-01" }, { deadline: Date.now() + 60_000 });
    expect(db.rows("kb_factchecks")).toEqual([]);
    expect(db.rows("kb_documents")).toEqual([]);
    expect(summaryOf(logs)).toContain('"robots_txt":1');
  });

  it("[RF15] web-finds: robots.txt \"Disallow: /\" ou com erro (500) ⇒ skipped/robots_txt", async () => {
    fakeFetch({
      "https://www1.folha.uol.com.br/robots.txt": () => new Response("User-agent: *\nDisallow: /\n"),
      "https://g1.globo.com/robots.txt": () => new Response("erro", { status: 500 }),
    });
    const folha = "https://www1.folha.uol.com.br/cotidiano/2030/03/ponte-nova.shtml";
    const g1 = "https://g1.globo.com/fato-ou-fake/noticia/2030/03/14/e-falso-que-a-inflacao-chegou-a-40.ghtml";
    const db = webFindsDb([find(folha, NOTICIA, { tier: 2 }), find(g1, CHECAGEM, { title: CHECAGEM_TITULO })]);
    await drain(testCtx(db).ctx, { kind: "web-finds", limit: 10 });
    expect(db.rows("kb_web_finds").map((r) => [r.url, r.status, r.note])).toEqual([
      [folha, "skipped", "robots_txt"],
      [g1, "skipped", "robots_txt"],
    ]);
    expect(db.rows("kb_documents")).toEqual([]);
    expect(db.rows("kb_factchecks")).toEqual([]);
  });
});

describe("[RF15] checagem L1 precisa de data", () => {
  it("[RF15] data no começo do texto: formatos das agências; só em linha de data", () => {
    expect(dateFromText("Título da checagem\nPublicado em 15 de outubro de 2026 às 10h00\nTexto.")).toBe("2026-10-15");
    expect(dateFromText("Título\n15/10/2026 10h00 Atualizado há 2 horas\nTexto.")).toBe("2026-10-15");
    expect(dateFromText("Por Fulano de Tal\n15.out.2026 às 18h30")).toBe("2026-10-15");
    expect(dateFromText("15 out 2026 - 10:00")).toBe("2026-10-15");
    expect(dateFromText("15 de out. de 2026")).toBe("2026-10-15");
    expect(dateFromText("2026-10-15T10:00:00-03:00")).toBe("2026-10-15");
    expect(dateFromText("1º de março de 2026")).toBe("2026-03-01");
    expect(dateFromText("Publicado em 15/10/2026 às 10h00.")).toBe("2026-10-15");
    // "Publicado em" vence data de título
    expect(dateFromText("Lula diz que a ponte caiu em 12 de março de 2024\nPublicado em 15/10/2026.")).toBe("2026-10-15");
    // data no meio de parágrafo é do assunto, não da página
    expect(dateFromText("O vídeo, publicado em 12/03/2024, mostra o deputado na tribuna.")).toBeNull();
    // depois dos primeiros ~2000 caracteres não conta
    expect(dateFromText(`${"Texto da matéria sem data nenhuma. ".repeat(60)}\n15/10/2026`)).toBeNull();
    expect(dateFromText("31/02/2026")).toBeNull();
    expect(dateFromText("15/13/2026")).toBeNull();
    expect(dateFromText(CHECAGEM)).toBeNull();
    // pageFromText usa a data do texto quando a URL e o buscador não têm
    expect(pageFromText({ url: "https://aosfatos.org/noticias/x/", text: DUAS_FALAS }).publishedAt).toBe("2030-03-15");
  });

  it("[RF15] checagem com selo sem data em lugar nenhum ⇒ documento da agência sem data; com linha de data ⇒ L1", async () => {
    const semData = "https://aosfatos.org/noticias/e-falso-que-a-inflacao-chegou-a-40";
    const comData = "https://aosfatos.org/noticias/e-falso-que-a-inflacao-chegou-a-40-de-novo";
    const comDataTexto = CHECAGEM.replace(CHECAGEM_TITULO, `${CHECAGEM_TITULO}\nPublicado em 14 de março de 2030, às 18h`);
    const db = new FakeDb();
    const { ctx, logs } = testCtx(db);
    await processCandidates(ctx, [withPage(semData, CHECAGEM_TITULO, CHECAGEM), withPage(comData, CHECAGEM_TITULO, comDataTexto)], {});

    expect(db.rows("kb_factchecks").map((r) => [r.url, r.published_at])).toEqual([[comData, "2030-03-14T00:00:00.000Z"]]);
    expect(db.rows("kb_documents")).toHaveLength(1);
    expect(db.rows("kb_documents")[0]).toMatchObject({ url: semData, source_name: "Aos Fatos", tier: 1, published_at: null });
    expect(summaryOf(logs)).toContain('"virou_documento":1');
  });

  it("[RF15] factchecks-tavily: sem data no buscador nem na URL ⇒ data do texto; anterior a `since` ⇒ antiga; sem data ⇒ fora", () => {
    const r = (url: string, raw_content: string) => ({ url, title: "t", raw_content, published_date: null });
    const antigaTexto = CHECAGEM.replace(CHECAGEM_TITULO, `${CHECAGEM_TITULO}\n10/01/2029`);
    const recenteTexto = CHECAGEM.replace(CHECAGEM_TITULO, `${CHECAGEM_TITULO}\n14.mar.2030`);
    const { candidates, dropped } = candidatesFromSearch(
      [
        r("https://aosfatos.org/noticias/checagem-antiga", antigaTexto),
        r("https://aosfatos.org/noticias/checagem-recente", recenteTexto),
        r("https://aosfatos.org/noticias/checagem-sem-data", CHECAGEM),
      ],
      "2030-02-01",
    );
    // sem data nenhuma não segue (home, seção e lista nunca têm data)
    expect(dropped).toEqual({ antiga: 1, sem_data: 1 });
    expect(candidates.map((c) => [c.url, c.publishedAt])).toEqual([["https://aosfatos.org/noticias/checagem-recente", "2030-03-14"]]);
  });

  it("[RF15] web-finds: checagem de agência sem data ⇒ documento sem data, não L1", async () => {
    const url = "https://aosfatos.org/noticias/e-falso-que-a-inflacao-chegou-a-40";
    const db = webFindsDb([find(url, CHECAGEM, { title: `${CHECAGEM_TITULO} - Aos Fatos`, source_name: "Aos Fatos" })]);
    await drain(testCtx(db).ctx, { kind: "web-finds", limit: 10 });
    expect(db.rows("kb_factchecks")).toEqual([]);
    expect(db.rows("kb_documents")).toHaveLength(1);
    expect(db.rows("kb_documents")[0]).toMatchObject({ url, origin: "web", published_at: null, title: CHECAGEM_TITULO });
    expect(db.rows("kb_web_finds")[0]).toMatchObject({ status: "done", note: "documento" });
  });
});

describe("[RF15] documento lido pela Tavily não substitui o que já está na base", () => {
  it("[RF15] etapa document e comando documents: download recusado + documento existente ⇒ mantém e avisa; sem documento ⇒ grava", async () => {
    const existe = "https://doc-bloqueado.test/2030/03/14/programa";
    const novo = "https://doc-bloqueado.test/2030/03/14/plano";
    fakeFetch({
      [existe]: () => new Response("Access Denied", { status: 403 }),
      [novo]: () => new Response("Access Denied", { status: 403 }),
      [TAVILY_EXTRACT]: (init) =>
        Response.json({ results: [{ url: (jsonBody(init).urls as string[])[0], title: "Página parcial", raw_content: NOTICIA }] }),
    });
    const curado: Row = { id: "doc-curado", url: existe, title: "Programa de governo", body: "texto inteiro baixado antes", doc_type: "programa" };
    const db = new FakeDb({ kb_documents: [curado] });
    const { ctx, logs, warns } = testCtx(db);

    await runStep(
      ctx,
      { kind: "document", url: existe, title: "Programa de governo", doc_type: "programa", person: null, published_at: null },
      { deadline: Date.now() + 60_000 },
    );
    expect(db.rows("kb_documents")).toEqual([curado]);
    expect(warns.join("\n")).toContain(`${existe}: download recusado; documento existente mantido`);

    const dir = mkdtempSync(join(tmpdir(), "kb-docs-"));
    try {
      const manifest = join(dir, "documents.yaml");
      writeFileSync(
        manifest,
        [
          "documents:",
          `  - { url: "${existe}", title: "Programa de governo", doc_type: programa }`,
          `  - { url: "${novo}", title: "Plano de obras", doc_type: programa }`,
        ].join("\n"),
      );
      await runDocuments(ctx, { manifest });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(db.rows("kb_documents").find((d) => d.url === existe)).toEqual(curado);
    expect(db.rows("kb_chunks").some((c) => c.document_id === "doc-curado")).toBe(false);
    expect(db.rows("kb_documents").find((d) => d.url === novo)).toMatchObject({ title: "Plano de obras", published_at: "2030-03-14" });
    expect(String(db.rows("kb_documents").find((d) => d.url === novo)!.body)).toContain("rio Fictício");
    expect(logs).toContain('documentos: {"skipped":1,"written":1}');
    expect(warns.filter((w) => w.includes("documento existente mantido"))).toHaveLength(2);
  });
});

describe("[RF15] título e selo", () => {
  it("[RF15] título do UOL com data: tira data e nome do site em laço", () => {
    const uol = "https://noticias.uol.com.br/confere/ultimas-noticias/2030/03/14/e-falso.htm";
    expect(cleanPageTitle("É falso que a ponte de Vila Imaginária caiu - 20/10/2026 - UOL Confere", uol)).toBe(
      "É falso que a ponte de Vila Imaginária caiu",
    );
    expect(cleanPageTitle("É falso que a ponte de Vila Imaginária caiu - 20/10/2026", uol)).toBe("É falso que a ponte de Vila Imaginária caiu");
    // parte do título que não é data nem site fica
    expect(cleanPageTitle("Inflação sobe em março - entenda - 20/10/2026 - UOL Confere", uol)).toBe("Inflação sobe em março - entenda");
  });

  it("[RF15] vários rótulos com selos diferentes ⇒ sem selo único: não vira L1, vira documento da agência (com a data do texto)", async () => {
    const url = "https://aosfatos.org/noticias/checamos-as-falas-do-prefeito-de-vila-imaginaria";
    const db = new FakeDb();
    const { ctx, logs } = testCtx(db);
    await processCandidates(ctx, [withPage(url, "Checamos as falas do prefeito de Vila Imaginária sobre a economia - Aos Fatos", DUAS_FALAS)], {});
    expect(db.rows("kb_factchecks")).toEqual([]);
    expect(db.rows("kb_documents")).toHaveLength(1);
    expect(db.rows("kb_documents")[0]).toMatchObject({
      url,
      title: "Checamos as falas do prefeito de Vila Imaginária sobre a economia",
      published_at: "2030-03-15T00:00:00.000Z",
    });
    expect(summaryOf(logs)).toContain('"virou_documento":1');
  });
});
