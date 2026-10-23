// A base aprende com a web: as páginas da L4 vão para a fila kb_web_finds depois dos
// alertas do trecho (deps falsas, sem rede).
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEB_FIND_MAX_CHARS, WEB_FIND_MIN_CHARS } from "../src/config";
import type { ExtractionOutput } from "../src/extract";
import { createPipeline } from "../src/index";
import type { WebResult, WebSearchFn } from "../src/retrieve/web";
import type { EvidenceCandidate } from "../src/types";
import type { VerifyOutput } from "../src/verify";
import { webFindRows } from "../src/webFinds";
import {
  DEBATE_ID, DOC_CHUNK, fakeAnthropic, fakeRerank, fakeWeb, makeDeps, MemoryStore, type FakeReply,
} from "./helpers";

type ClaimOut = ExtractionOutput["claims"][number];
const claimOut = (original: string, normalized: string, over: Partial<Pick<ClaimOut, "tipo" | "measurable">> = {}): ClaimOut => ({
  text_original: original, text_normalized: normalized, topic: "saude", tipo: "fato", measurable: null, numbers: [],
  indicator: null, reference: null, time_reference: null, transcricao_duvidosa: false, ...over,
});
const extracting = (...claims: ClaimOut[]) => (): FakeReply<ExtractionOutput> => ({ output: { claims } });

const DOC_SEGMENT = "O Mais Médicos foi criado em 2015 pelo governo Temer.";
const DOC_CLAIM = claimOut("O Mais Médicos foi criado em 2015 pelo governo Temer", "O programa Mais Médicos foi criado em 2015 pelo governo Michel Temer.");
/** Citação literal do DOC_CHUNK: com a base forte, o vermelho sai publicado. */
const DOC_VERDICT: FakeReply<VerifyOutput> = {
  output: {
    rationale: "r", verdict: "contradito", confidence: 0.95,
    correction: "O Mais Médicos foi criado pela Lei 12.871, de 22 de outubro de 2013, no governo Dilma.",
    summary: "O Mais Médicos é de 2013 (Lei 12.871), governo Dilma.",
    citations: [{ evidence_index: 1, quote: "criado pela Lei 12.871, sancionada em 22 de outubro de 2013, durante o governo Dilma Rousseff" }],
  },
};
const SILENT: FakeReply<VerifyOutput> = {
  output: { rationale: "r", verdict: "inconclusivo", confidence: 0.2, correction: "", summary: "", citations: [] },
};

/** Página inteira (acima de WEB_FIND_MIN_CHARS), com acentos (passa no filtro de codificação). */
const longText = (frase: string) => `  ${`${frase} `.repeat(Math.ceil((WEB_FIND_MIN_CHARS + 200) / (frase.length + 1)))}`;
const page = (url: string, frase: string, over: Partial<WebResult> = {}): WebResult => ({
  url, title: frase.slice(0, 40), content: frase, raw_content: longText(frase), published_date: "2013-10-22", score: 0.9, ...over,
});
const G1 = page("https://g1.globo.com/saude/noticia/2013/10/22/dilma-sanciona-lei-do-mais-medicos.ghtml",
  "A presidente Dilma Rousseff sancionou nesta terça-feira (22) a lei que cria o programa Mais Médicos.");
const FOLHA = page("https://www1.folha.uol.com.br/equilibrioesaude/2013/10/mais-medicos-vira-lei.shtml",
  "O programa Mais Médicos virou lei com a sanção da presidente Dilma Rousseff em outubro de 2013.");
const ESTADAO = page("https://www.estadao.com.br/economia/projecoes-pib-2027/",
  "As projeções de crescimento do PIB para 2027 ficaram em torno de 2% no boletim Focus.");
/** Só o trecho do buscador (a página inteira não veio): fica de fora da fila. */
const SHORT = page("https://oglobo.globo.com/saude/mais-medicos-2013.html",
  "Lei do Mais Médicos é sancionada.", { raw_content: null });
/** Fora dos níveis 1–2: o buscador ignorou include_domains (a L4 já descarta). */
const BLOG = page("https://blog.exemplo.com/mais-medicos", "Opinião sobre o Mais Médicos e a sanção da lei em 2013.");

function setup(opts: {
  web: WebSearchFn; verify?: (u: string) => FakeReply<VerifyOutput>; claims?: ClaimOut[];
  chunks?: boolean; learnFromWeb?: boolean; delays?: Record<string, number>;
}) {
  const store = new MemoryStore(opts.chunks ? { chunks: [DOC_CHUNK] } : {}, { require_red_approval: false }, opts.delays ?? {});
  const deps = makeDeps({
    store, webSearch: opts.web, rerank: fakeRerank({ score: 0.9 }),
    learnFromWeb: "learnFromWeb" in opts ? opts.learnFromWeb : true,
    anthropic: fakeAnthropic({ extract: extracting(...(opts.claims ?? [DOC_CLAIM])), verify: opts.verify ?? (() => DOC_VERDICT) }),
  });
  return { store, deps, pipeline: createPipeline(deps) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("[RF15] a base aprende com a web (fila kb_web_finds)", () => {
  it("base forte: a web não entra na verificação, mas a página inteira vai para a fila", async () => {
    let verifyMsg = "";
    const web = fakeWeb([G1, SHORT, BLOG]);
    const { store, deps, pipeline } = setup({ web, chunks: true, verify: (u) => ((verifyMsg = u), DOC_VERDICT) });
    const seg = store.addSegment(DOC_SEGMENT);
    const res = await pipeline.runPipeline(seg.id);

    expect(res).toMatchObject({ claims: 1, alerts: 1, web_finds: 1 });
    expect(store.alerts[0]).toMatchObject({ status: "published" });
    // a web não foi usada na decisão
    expect(verifyMsg).not.toContain(G1.url);
    expect(store.verifications[0]?.latency_ms).not.toHaveProperty("retrieve_L4");
    // só a página de nível ≤ 2 com o texto inteiro
    expect(store.webFinds).toEqual([{
      url: G1.url, title: G1.title, text: G1.raw_content!.trim(), source_name: "g1", tier: 2,
      published_at: "2013-10-22T00:00:00.000Z", query: DOC_CLAIM.text_normalized, debate_id: DEBATE_ID,
    }]);
    expect(deps.logs.find((l) => l.event === "web_finds_saved")?.fields).toMatchObject({ segment_id: seg.id, n: 1 });
  });

  it("base fraca (web entrou na verificação): várias afirmações, uma linha por URL, com a busca usada", async () => {
    const prev = claimOut("a indústria brasileira está sucateada", "A indústria brasileira está sucateada.", {
      tipo: "opiniao_mensuravel", measurable: "produção industrial do Brasil em 2025 e 2026 (IBGE)",
    });
    const web: WebSearchFn = async (q) => (q === prev.measurable ? [FOLHA, ESTADAO] : [G1, FOLHA]);
    const { store, pipeline } = setup({ web, claims: [DOC_CLAIM, prev], verify: () => SILENT });
    const res = await pipeline.runPipeline(store.addSegment(`${DOC_SEGMENT} A indústria brasileira está sucateada.`).id);

    expect(res).toMatchObject({ claims: 2, alerts: 0, web_finds: 3 });
    expect(store.webFinds.map((w) => w.url).sort()).toEqual([ESTADAO.url, FOLHA.url, G1.url].sort());
    expect(store.webFinds.find((w) => w.url === G1.url)?.query).toBe(DOC_CLAIM.text_normalized);
    // opinião mensurável: a busca é o dado que mede a fala
    expect(store.webFinds.find((w) => w.url === ESTADAO.url)?.query).toBe(prev.measurable);
    // uma inserção por trecho
    expect(store.calls.filter((c) => c === "saveWebFinds")).toHaveLength(1);
  });

  it("página já na fila não conta de novo; repetição (trava) e mediação não buscam nem gravam", async () => {
    const web = fakeWeb([G1]);
    const { store, pipeline } = setup({ web, chunks: true });
    expect((await pipeline.runPipeline(store.addSegment(DOC_SEGMENT).id)).web_finds).toBe(1);
    // a mesma afirmação de novo: trava de repetição, sem busca
    const rep = await pipeline.runPipeline(store.addSegment(DOC_SEGMENT).id);
    expect(rep).toMatchObject({ alerts: 1, web_finds: 0 });
    expect(web.calls).toBe(1);
    expect(store.calls.filter((c) => c === "saveWebFinds")).toHaveLength(1);

    // outra afirmação que acha a mesma página: a fila ignora a URL repetida
    const other = claimOut("O Mais Médicos é de 2016", "O programa Mais Médicos foi criado em 2016.");
    const b = setup({ web: fakeWeb([G1]), chunks: true, claims: [other] });
    b.store.webFinds.push({ ...store.webFinds[0]! });
    expect((await b.pipeline.runPipeline(b.store.addSegment("O Mais Médicos é de 2016, isso sim.").id)).web_finds).toBe(0);
    expect(b.store.webFinds).toHaveLength(1);

    // fala da mediação: nem extrai
    const m = setup({ web: fakeWeb([G1]), chunks: true });
    m.store.speakerMap = [{ speaker_label: "SPEAKER_1", person: "Mediação" }];
    expect(await m.pipeline.runPipeline(m.store.addSegment(DOC_SEGMENT).id)).toMatchObject({ claims: 0, web_finds: 0 });
    expect(m.store.webFinds).toHaveLength(0);
  });

  it("webFindRows: só L4 de nível ≤ 2, http(s), texto longo, uma por URL; texto cortado sem partir emoji", () => {
    const base: EvidenceCandidate = {
      layer: "L4", evidence_type: "web", url: G1.url, source_name: "g1", source_tier: 2, published_at: "Tue, 22 Oct 2013 10:00:00 GMT",
      title: null, text: G1.raw_content!, relevance: 0.9,
    };
    // emoji (par substituto) exatamente na fronteira do corte
    const huge = `${"á".repeat(WEB_FIND_MAX_CHARS - 1)}😀 resto`;
    const rows = webFindRows([
      { query: "q1", candidates: [
        base,
        { ...base, url: "https://blog.exemplo.com/x", source_tier: 3 },
        { ...base, url: "ftp://g1.globo.com/arquivo" },
        { ...base, url: "https://g1.globo.com/curta", text: "x".repeat(WEB_FIND_MIN_CHARS - 1) },
        { ...base, layer: "L3", evidence_type: "document", url: "https://www.planalto.gov.br/lei" },
        { ...base, url: "https://www.bcb.gov.br/nul", source_tier: 1, published_at: "ontem", text: `\u0000${G1.raw_content}` },
      ] },
      { query: "q2", candidates: [{ ...base, url: G1.url }, { ...base, url: "https://www.ibge.gov.br/grande", text: huge }] },
    ], DEBATE_ID);

    expect(rows.map((r) => [r.url, r.query])).toEqual([
      [G1.url, "q1"], ["https://www.bcb.gov.br/nul", "q1"], ["https://www.ibge.gov.br/grande", "q2"],
    ]);
    expect(rows[0]).toMatchObject({ title: "", tier: 2, published_at: "2013-10-22T10:00:00.000Z", debate_id: DEBATE_ID });
    // data ilegível vira null; \u0000 sai (não cabe em text no Postgres)
    expect(rows[1]).toMatchObject({ published_at: null, tier: 1 });
    expect(rows[1]!.text).not.toContain("\u0000");
    expect(rows[2]!.text).toHaveLength(WEB_FIND_MAX_CHARS - 1);
    expect(rows[2]!.text.at(-1)).toBe("á");
  });
});

describe("[RNF03] gravar a fila nunca atrasa nem muda alerta", () => {
  it("o alerta é publicado antes de a página ir para a fila (e antes de a web terminar)", async () => {
    const web = fakeWeb([G1], { delayMs: 500 });
    const { store, pipeline } = setup({ web, chunks: true });
    const run = pipeline.runPipeline(store.addSegment(DOC_SEGMENT).id);
    // base forte: o alerta sai sem esperar a web
    await vi.waitFor(() => expect(store.alerts).toHaveLength(1), { timeout: 400, interval: 10 });
    expect(store.alerts[0]).toMatchObject({ status: "published" });
    expect(store.calls).not.toContain("saveWebFinds");

    const res = await run;
    expect(res).toMatchObject({ alerts: 1, web_finds: 1 });
    expect(store.calls.indexOf("insertAlert")).toBeGreaterThanOrEqual(0);
    expect(store.calls.indexOf("insertAlert")).toBeLessThan(store.calls.indexOf("saveWebFinds"));
  });

  it("falha ao gravar ⇒ só log; alertas iguais, sem exceção", async () => {
    const { store, deps, pipeline } = setup({ web: fakeWeb([G1]), chunks: true });
    store.failing.add("saveWebFinds");
    const seg = store.addSegment(DOC_SEGMENT);
    await expect(pipeline.runPipeline(seg.id)).resolves.toMatchObject({ claims: 1, alerts: 1, web_finds: 0 });
    expect(store.alerts[0]).toMatchObject({ status: "published", verdict: "contradito" });
    expect(store.webFinds).toHaveLength(0);
    expect(deps.logs.find((l) => l.event === "web_finds_failed")).toMatchObject({ level: "warn", fields: { segment_id: seg.id } });
  });

  it("gravação travada ⇒ timeout, só log; alertas iguais", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { store, deps, pipeline } = setup({ web: fakeWeb([G1]), chunks: true, delays: { saveWebFinds: 600_000 } });
    const run = pipeline.runPipeline(store.addSegment(DOC_SEGMENT).id);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(run).resolves.toMatchObject({ claims: 1, alerts: 1, web_finds: 0 });
    expect(store.alerts[0]).toMatchObject({ status: "published" });
    expect(deps.logs.find((l) => l.event === "web_finds_failed")?.fields?.error).toMatch(/timeout: web_finds/);
  });

  it("chave desligada (ou store sem o método) ⇒ nada gravado nem esperado", async () => {
    for (const learnFromWeb of [false, undefined]) {
      const { store, pipeline } = setup({ web: fakeWeb([G1]), chunks: true, learnFromWeb });
      const res = await pipeline.runPipeline(store.addSegment(DOC_SEGMENT).id);
      expect(res).toMatchObject({ alerts: 1, web_finds: 0 });
      expect(store.calls).not.toContain("saveWebFinds");
    }
    const { store, pipeline } = setup({ web: fakeWeb([G1]), chunks: true });
    Object.assign(store, { saveWebFinds: undefined });
    expect(await pipeline.runPipeline(store.addSegment(DOC_SEGMENT).id)).toMatchObject({ alerts: 1, web_finds: 0 });
    expect(store.webFinds).toHaveLength(0);
  });

  it("evaluateText (eval) nunca grava", async () => {
    const web = fakeWeb([G1]);
    const { store, pipeline } = setup({ web });
    const decisions = await pipeline.evaluateText(DOC_SEGMENT, "");
    expect(decisions).toHaveLength(1);
    expect(web.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.calls).not.toContain("saveWebFinds");
    expect(store.webFinds).toHaveLength(0);
  });
});
