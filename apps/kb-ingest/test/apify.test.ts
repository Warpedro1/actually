// Mapeamento da saída dos Actors (sem rede). Itens montados conforme os campos
// documentados no plugin Apify (url, text/markdown, metadata.title; organicResults[]);
// o conteúdo é fictício.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillTemplate, filterByDomains, mapCrawlItem, mapSearchItem, mapTranscriptItem, stripMarkdown } from "../src/apify/map";
import { loadApifyManifest, CrawlJob } from "../src/apify/client";
import { crawlInput, crawlItemsToFactchecks, youtubeId } from "../src/commands/apify";

const ARTICLE = [
  "# É falso que a ponte de Vila Imaginária custou R$ 9 bilhões",
  "",
  "Circula nas redes um vídeo em que o deputado Fulano de Tal afirma que a ponte custou R$ 9 bilhões. A **Agência Exemplo** verificou os contratos e concluiu que a informação é falsa.",
  "",
  "Segundo os dados do [Portal de Obras](https://obras.exemplo.org), o custo total da ponte foi de R$ 412 milhões, valor quase 22 vezes menor do que o citado.",
  "",
  "Classificação: Falso",
].join("\n");

describe("[RF15] website-content-crawler (Apify)", () => {
  it("item → página (text ou markdown, metadata.title)", () => {
    expect(mapCrawlItem({ url: "https://a.org/x", text: "Olá **mundo**", metadata: { title: "T" } })).toEqual({
      url: "https://a.org/x",
      title: "T",
      text: "Olá mundo",
      publishedAt: null,
    });
    expect(mapCrawlItem({ crawl: { loadedUrl: "https://a.org/y" }, markdown: "# Título\n\ntexto" })?.text).toBe("Título\n\ntexto");
    expect(mapCrawlItem({ url: "https://a.org/z" })).toBeNull();
    expect(mapCrawlItem({ url: "ftp://a.org", text: "x" })).toBeNull();
  });
  it("markdown → texto mantém as palavras visíveis", () => {
    expect(stripMarkdown("Veja [o dado](https://x) e ![img](y) **forte** e _ênfase_ `cod`\n> citação")).toBe(
      "Veja o dado e  forte e ênfase cod\ncitação",
    );
  });
  it("[RF15] job factcheck: página com rating e data vira checagem com trecho literal; sem data não", () => {
    const job = CrawlJob.parse({ name: "x", kind: "factcheck", start_urls: ["https://checagem.exemplo.org/"] });
    const { rows, reasons } = crawlItemsToFactchecks(
      [
        {
          url: "https://checagem.exemplo.org/ponte",
          markdown: ARTICLE,
          metadata: { title: "É falso que a ponte de Vila Imaginária custou R$ 9 bilhões", datePublished: "2030-03-14" },
        },
        // a mesma checagem sem data em lugar nenhum não vira L1 (passaria por atual)
        { url: "https://checagem.exemplo.org/ponte-sem-data", markdown: ARTICLE, metadata: { title: "É falso que a ponte de Vila Imaginária custou R$ 9 bilhões" } },
        { url: "https://checagem.exemplo.org/sobre", text: "Quem somos. ".repeat(40), metadata: { title: "Sobre" } },
        { url: "https://checagem.exemplo.org/vazio" },
      ],
      job,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: "contradito",
      rating_original: "falso",
      claim_text: "A ponte de Vila Imaginária custou R$ 9 bilhões",
      published_at: "2030-03-14T00:00:00.000Z",
    });
    expect(rows[0]!.body.includes(rows[0]!.quote)).toBe(true);
    expect(reasons).toEqual({ sem_rating: 1, sem_data: 1, item_invalido: 1 });
  });
  it("input do Actor a partir do template do manifesto", () => {
    const job = CrawlJob.parse({ name: "x", kind: "document", start_urls: ["https://a.org/"], max_pages: 7, input_extra: { foo: 1 } });
    expect(crawlInput({ startUrls: "$START_URLS", maxCrawlPages: "$MAX_PAGES", fixo: "ok" }, job)).toEqual({
      startUrls: [{ url: "https://a.org/" }],
      maxCrawlPages: 7,
      fixo: "ok",
      foo: 1,
    });
  });
});

describe("[RF15] transcrições do YouTube (Apify)", () => {
  it("aceita string ou lista de segmentos com vários nomes de campo", () => {
    expect(mapTranscriptItem({ url: "https://youtu.be/abc", title: "T", transcript: "texto corrido" })).toEqual({
      url: "https://youtu.be/abc",
      title: "T",
      text: "texto corrido",
    });
    expect(
      mapTranscriptItem({ videoUrl: "https://www.youtube.com/watch?v=abc", data: [{ text: "Boa noite", start: 1.2 }, { text: "começa", start: "65" }] })?.text,
    ).toBe("[00:01] Boa noite\n[01:05] começa");
    expect(mapTranscriptItem({ captions: [{ text: "oi", tStartMs: 3000 }] }, "https://youtu.be/x")?.text).toBe("[00:03] oi");
    expect(mapTranscriptItem({ url: "https://youtu.be/abc" })).toBeNull();
  });
  it("id do vídeo em vários formatos de URL", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=AbC123&t=10")).toBe("AbC123");
    expect(youtubeId("https://youtu.be/AbC123?si=x")).toBe("AbC123");
    expect(youtubeId("https://www.youtube.com/live/AbC123")).toBe("AbC123");
    expect(youtubeId("https://exemplo.org")).toBeNull();
  });
});

describe("google-search-scraper", () => {
  it("resultados orgânicos filtrados por domínio tier 1–2", () => {
    const res = mapSearchItem({
      searchQuery: { term: "checagem Lula" },
      organicResults: [
        { url: "https://www.aosfatos.org/noticias/x", title: "A", description: "d" },
        { url: "https://lupa.uol.com.br/jornalismo/y", title: "B", snippet: "s" },
        { url: "https://blog.qualquer.net/z", title: "C" },
      ],
    });
    expect(res.map((r) => r.query)).toEqual(["checagem Lula", "checagem Lula", "checagem Lula"]);
    expect(filterByDomains(res, ["aosfatos.org", "uol.com.br"]).map((r) => r.title)).toEqual(["A", "B"]);
    expect(mapSearchItem({})).toEqual([]);
  });
  it("marcadores de consulta", () => {
    expect(fillTemplate({ queries: "$QUERIES_NEWLINE", list: "$QUERIES", n: 1 }, { $QUERIES_NEWLINE: "a\nb", $QUERIES: ["a", "b"] })).toEqual({
      queries: "a\nb",
      list: ["a", "b"],
      n: 1,
    });
  });
});

describe("manifesto sources/apify.yaml", () => {
  it("é válido e só usa marcadores conhecidos", () => {
    const m = loadApifyManifest(join(import.meta.dirname, "../sources/apify.yaml"));
    expect(m.crawl?.actor).toBe("apify/website-content-crawler");
    expect(m.crawl?.jobs?.length).toBeGreaterThan(0);
    for (const j of m.crawl!.jobs!) for (const u of j.start_urls) expect(u).toMatch(/^https:\/\//);
    expect(m.search?.actor).toBe("apify/google-search-scraper");
    expect(m.youtube?.input ?? null).toBeNull(); // pendente até confirmar o schema
  });
});
