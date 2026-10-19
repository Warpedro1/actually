// Coletores: feeds, Google Fact Check, Senado, Deepgram, robots, classificação.
// Fixtures/objetos daqui seguem os schemas documentados; o conteúdo é fictício.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFeedLinks, parseFeed } from "../src/factchecks/feeds";
import { googleSearchUrl, parseGoogleResponse } from "../src/factchecks/google";
import { findSenador, parseDiscursos, parseSenadores, parseVotacoes, votacaoToDocument, yearWindows } from "../src/senado/api";
import { fromDeepgram, localFileToText, parseSpeakerMap, transcriptToText } from "../src/transcribe/format";
import { isAllowed, parseRobots } from "../src/lib/robots";
import { detectPerson, detectTopic, detectTopics } from "../src/lib/classify";
import { validateDocument } from "../src/documents/ingest";
import { toDocumentInput } from "../src/commands/documents";
import { isYoutube } from "../src/commands/transcribe";

describe("feeds", () => {
  it("RSS 2.0 → itens", () => {
    const items = parseFeed(readFileSync(join(import.meta.dirname, "fixtures/feed_formato.sample.xml"), "utf8"));
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "É falso que a ponte de Vila Imaginária custou R$ 9 bilhões",
      url: "https://checagem.exemplo.org/2030/03/ponte-vila-imaginaria",
      publishedAt: "Thu, 14 Mar 2030 13:00:00 +0000",
      categories: ["Checagem", "Obras"],
    });
  });
  it("Atom → itens", () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title>
      <link rel="alternate" href="https://a.org/1"/><published>2030-01-01T00:00:00Z</published></entry></feed>`;
    expect(parseFeed(atom)).toEqual([{ title: "T", url: "https://a.org/1", publishedAt: "2030-01-01T00:00:00Z", categories: [] }]);
  });
  it("auto-descoberta pelo <link rel=alternate>, sem feed de comentários", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed/">
      <link rel="alternate" type="application/rss+xml" href="/comments/feed/">
      <link rel="alternate" type="application/atom+xml" href="https://b.org/atom.xml">
      <link rel="stylesheet" href="/s.css"></head></html>`;
    expect(discoverFeedLinks(html, "https://a.org/checagens/")).toEqual(["https://a.org/feed/", "https://b.org/atom.xml"]);
  });
});

describe("Google Fact Check Tools", () => {
  it("uma checagem por claimReview em português", () => {
    const res = {
      claims: [
        {
          text: "Afirmação X",
          claimant: "Fulano",
          claimDate: "2030-01-01T00:00:00Z",
          claimReview: [
            { publisher: { name: "Agência Exemplo", site: "exemplo.org" }, url: "https://exemplo.org/a", title: "T", reviewDate: "2030-01-02T00:00:00Z", textualRating: "Falso", languageCode: "pt" },
            { publisher: { name: "Example" }, url: "https://example.com/a", textualRating: "False", languageCode: "en" },
            { url: "nao-e-url", textualRating: "Falso", languageCode: "pt" },
          ],
        },
        { text: "sem reviews" },
      ],
      nextPageToken: "abc",
    };
    expect(parseGoogleResponse(res)).toEqual([
      { url: "https://exemplo.org/a", sourceName: "Agência Exemplo", title: "T", claimText: "Afirmação X", claimant: "Fulano", ratingOriginal: "Falso", publishedAt: "2030-01-02T00:00:00Z" },
    ]);
    expect(parseGoogleResponse({})).toEqual([]);
  });
  it("URL com languageCode=pt, maxAgeDays e pageToken", () => {
    const u = new URL(googleSearchUrl({ query: "Flávio Bolsonaro", key: "K", maxAgeDays: 30, pageToken: "p2" }));
    expect(u.origin + u.pathname).toBe("https://factchecktools.googleapis.com/v1alpha1/claims:search");
    expect(Object.fromEntries(u.searchParams)).toEqual({ query: "Flávio Bolsonaro", languageCode: "pt", pageSize: "100", key: "K", maxAgeDays: "30", pageToken: "p2" });
  });
});

describe("[RF15] Senado", () => {
  const lista = {
    ListaParlamentarEmExercicio: {
      Parlamentares: {
        Parlamentar: [
          { IdentificacaoParlamentar: { CodigoParlamentar: "111", NomeParlamentar: "Fulano Senador", NomeCompletoParlamentar: "Fulano de Tal", SiglaPartidoParlamentar: "AAA", UfParlamentar: "ZZ" } },
          { IdentificacaoParlamentar: { CodigoParlamentar: "222", NomeParlamentar: "Flávio Bolsonaro", NomeCompletoParlamentar: "Nome Completo Fictício", SiglaPartidoParlamentar: "BBB", UfParlamentar: "YY" } },
        ],
      },
    },
  };
  it("lista e busca por nome sem acento; nunca adivinha", () => {
    const s = parseSenadores(lista);
    expect(findSenador(s, "flavio bolsonaro")?.codigo).toBe(222);
    expect(findSenador(s, "Ninguém")).toBeNull();
    expect(findSenador(parseSenadores({ AfastamentoAtual: { Parlamentares: { Parlamentar: lista.ListaParlamentarEmExercicio.Parlamentares.Parlamentar[0] } } }), "Fulano Senador")?.codigo).toBe(111);
  });
  it("votação → documento com voto do senador e URL única", () => {
    const votos = parseVotacoes(
      [
        {
          codigoSessao: 900001, codigoSessaoVotacao: 7001, dataSessao: "2030-05-06T00:00:00", sigla: "PL", numero: "1", ano: "2030",
          codigoMateria: 5, ementa: "Dispõe sobre a segurança pública em Vila Imaginária.", descricaoVotacao: "Votação do substitutivo.",
          resultadoVotacao: "A", totalVotosSim: 50, totalVotosNao: 20, totalVotosAbstencao: 1, votacaoSecreta: "N",
          votos: [
            { codigoParlamentar: 111, siglaVotoParlamentar: "Não", descricaoVotoParlamentar: "Não" },
            { codigoParlamentar: 222, siglaPartidoParlamentar: "BBB", siglaUFParlamentar: "YY", siglaVotoParlamentar: "Sim", descricaoVotoParlamentar: "Sim" },
          ],
        },
        { codigoSessao: 900002, codigoSessaoVotacao: 7002, dataSessao: "2030-05-07", identificacao: "PEC 2/2030", votacaoSecreta: "S", votos: [] },
      ],
      222,
    );
    expect(votos[0]).toMatchObject({ materia: "PL 1/2030", resultado: "Aprovada", voto: "Sim", partido: "BBB", uf: "YY", data: "2030-05-06" });
    const doc = votacaoToDocument(votos[0]!, "Flávio Bolsonaro")!;
    expect(doc.doc_type).toBe("votacao");
    expect(doc.person).toBe("Flávio Bolsonaro");
    expect(doc.url).toBe("https://legis.senado.leg.br/dadosabertos/votacao.json?codigoSessao=900001#votacao-7001");
    expect(doc.body).toContain("Voto de Flávio Bolsonaro (BBB-YY): Sim.");
    expect(doc.body).toContain("Resultado: Aprovada (Sim: 50; Não: 20; Abstenção: 1).");
    expect(doc.topics).toContain("seguranca");
    expect(votacaoToDocument(votos[1]!, "Flávio Bolsonaro")!.body).toContain("Votação secreta");
  });
  it("discursos e janelas anuais", () => {
    const d = parseDiscursos({
      DiscursosParlamentar: { Parlamentar: { Pronunciamentos: { Pronunciamento: { CodigoPronunciamento: "42", DataPronunciamento: "2030-01-02", TextoResumo: "R", UrlTexto: "https://x.org/42", TipoUsoPalavra: { Descricao: "Discurso" } } } } },
    });
    expect(d).toEqual([{ codigo: 42, data: "2030-01-02", resumo: "R", tipo: "Discurso", url: "https://x.org/42" }]);
    expect(yearWindows("2019-02-01", "2021-03-04")).toEqual([
      ["2019-02-01", "2019-12-31"],
      ["2020-01-01", "2020-12-31"],
      ["2021-01-01", "2021-03-04"],
    ]);
  });
});

describe("transcrição", () => {
  const dg = {
    metadata: { duration: 75.5 },
    results: {
      channels: [{ alternatives: [{ transcript: "tudo junto" }] }],
      utterances: [
        { start: 0.5, end: 3, speaker: 0, transcript: "Boa noite." },
        { start: 3.5, end: 6, speaker: 0, transcript: "Vamos começar." },
        { start: 7, end: 70, speaker: 1, transcript: "Obrigado pela pergunta." },
        { start: 71, end: 75, speaker: 0, transcript: "  " },
      ],
    },
  };
  it("Deepgram → falas; junta falas seguidas do mesmo falante", () => {
    const t = fromDeepgram(dg, "https://exemplo.org/v");
    expect(t.utterances).toHaveLength(3);
    expect(t.duration_s).toBe(75.5);
    expect(transcriptToText(t)).toBe("[00:00] Falante 0: Boa noite. Vamos começar.\n[00:07] Falante 1: Obrigado pela pergunta.");
    expect(transcriptToText(t, parseSpeakerMap("1=Mediadora"))).toContain("[00:07] Mediadora: Obrigado");
  });
  it("sem utterances usa o transcript do canal", () => {
    const t = fromDeepgram({ results: { channels: [{ alternatives: [{ transcript: "só texto" }] }] } }, "x");
    expect(t.utterances).toEqual([{ speaker: null, start: 0, end: 0, text: "só texto" }]);
  });
  it("arquivo local: txt como está, json em qualquer dos formatos", () => {
    expect(localFileToText("abc", "a.txt")).toBe("abc");
    expect(localFileToText(JSON.stringify(dg), "dg.json")).toContain("Falante 1");
    expect(localFileToText(JSON.stringify({ text: "x" }), "t.json")).toBe("x");
    expect(() => localFileToText("{}", "t.json")).toThrow();
  });
  it("reconhece URLs do YouTube", () => {
    expect(isYoutube("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isYoutube("https://youtu.be/abc")).toBe(true);
    expect(isYoutube("https://exemplo.org/a.mp3")).toBe(false);
  });
});

describe("robots.txt", () => {
  const txt = `User-agent: *\nDisallow: /busca\nAllow: /busca/publica\nCrawl-delay: 2\n\nUser-agent: OutroBot\nDisallow: /`;
  it("regra mais longa vence; crawl-delay", () => {
    const r = parseRobots(txt, "actually-kb-ingest");
    expect(isAllowed(r, "/checagem/1")).toBe(true);
    expect(isAllowed(r, "/busca?q=x")).toBe(false);
    expect(isAllowed(r, "/busca/publica/1")).toBe(true);
    expect(r.crawlDelayMs).toBe(2000);
  });
  it("grupo específico do agente tem prioridade", () => {
    expect(isAllowed(parseRobots(txt, "OutroBot/1.0"), "/x")).toBe(false);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /*.pdf$", "x"), "/a.pdf")).toBe(false);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /*.pdf$", "x"), "/a.pdf?x=1")).toBe(true);
  });
});

describe("pessoa e tópico", () => {
  it("pessoas", () => {
    expect(detectPerson("Lula disse que...")).toBe("Lula");
    expect(detectPerson("O senador Flávio Bolsonaro afirmou")).toBe("Flávio Bolsonaro");
    expect(detectPerson("Jair Bolsonaro em live")).toBe("Jair Bolsonaro");
    expect(detectPerson("Bolsonaro disse")).toBeNull(); // ambíguo
    expect(detectPerson(null, "Fulano", "Lula e Flávio Bolsonaro debatem")).toBe("Lula");
    expect(detectPerson("Flávio Bolsonaro", "Lula")).toBe("Flávio Bolsonaro"); // claimant primeiro
  });
  it("tópicos", () => {
    expect(detectTopic("A inflação e o desemprego caíram")).toBe("economia");
    expect(detectTopic("isenção do imposto de renda até R$ 5 mil")).toBe("impostos");
    expect(detectTopic("Bolsa Família atende famílias")).toBe("programas_sociais");
    expect(detectTopic("decreto de armas e CAC")).toBe("seguranca");
    expect(detectTopic("atos de 8 de janeiro no STF")).toBe("corrupcao_justica");
    expect(detectTopic("desmatamento na Amazônia")).toBe("meio_ambiente");
    expect(detectTopic("vacina da covid")).toBe("saude");
    expect(detectTopic("Enem e universidade")).toBe("educacao");
    expect(detectTopic("tarifa de Trump")).toBe("politica_externa");
    expect(detectTopic("receita de bolo")).toBeNull();
    expect(detectTopics("inflação, imposto de renda e IOF")[0]).toBe("impostos");
  });
});

describe("[RF15] documentos", () => {
  it("tier e fonte por lookupSource; validação", () => {
    const d = toDocumentInput({ url: "https://www.tse.jus.br/x.pdf", title: "Programa", doc_type: "programa", person: "Lula" }, "corpo ".repeat(20));
    expect(d).toMatchObject({ tier: 1, source_name: "TSE", person: "Lula", doc_type: "programa" });
    expect(toDocumentInput({ url: "https://blog.qualquer.net/a", title: "T", doc_type: "outro" }, "x").tier).toBe(4);
    expect(validateDocument({ ...d, url: "file:///a" })).toMatch(/http/);
    expect(validateDocument({ ...d, body: "curto" })).toMatch(/corpo/);
    expect(validateDocument(d)).toBeNull();
  });
});
