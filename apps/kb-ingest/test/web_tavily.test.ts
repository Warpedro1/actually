// RF15: a base aprende com a web e com as agências que recusam a Vercel.
// - páginas recusadas no download direto (403) são lidas pela Tavily; robots.txt proibindo, nunca;
// - matéria de agência com várias falas checadas vira documento L3 (sem sobrescrever documento curado);
// - etapa web-finds: fila kb_web_finds → checagem L1 ou documento L3 com origin 'web';
// - etapa factchecks-tavily: busca nas agências sem baixar de novo, filtrando caminho e data.
// Sem rede: fetch falso e banco em memória. Pessoas, lugares e números são fictícios.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// sem intervalo mínimo entre requisições ao mesmo host (lido quando lib/http é carregado)
vi.hoisted(() => {
  process.env.KB_INGEST_MIN_INTERVAL_MS = "0";
});

import type { KbWebFind } from "@actually/db";
import { processCandidates } from "../src/commands/factchecks";
import { fetchDocument } from "../src/documents/fetchDoc";
import { agencyQuery, candidatesFromSearch } from "../src/factchecks/agencySearch";
import { cleanPageTitle, dateFromUrl, pageFromText, type FactcheckCandidate } from "../src/factchecks/normalize";
import { HttpError } from "../src/lib/http";
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

    // página já obtida (busca): nada é baixado
    expect(calls).toEqual([]);
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
    expect(candidates.map((c) => c.url)).toEqual([
      "https://noticias.uol.com.br/confere/ultimas-noticias/2030/03/14/e-falso.htm",
      "https://checamos.afp.com/doc.afp.com.DEF456",
    ]);
    expect(candidates[0]).toMatchObject({ publishedAt: "2030-03-14", page: { publishedAt: "2030-03-14", claimReviews: [] } });
    expect(dropped).toEqual({ fora_da_agencia: 1, antiga: 1 });
  });

  it("[RF15] busca uma vez, não baixa as páginas: checagem com selo ⇒ L1, matéria com várias falas ⇒ documento, já na base ⇒ pula", async () => {
    const base = "https://g1.globo.com/fato-ou-fake/noticia";
    const selo = `${base}/2030/03/14/e-falso-que-a-inflacao-chegou-a-40.ghtml`;
    const varias = `${base}/checamos-a-sabatina-de-vila-imaginaria.ghtml`;
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
    expect(calls.map((c) => c.url)).toEqual([TAVILY_SEARCH]);
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
