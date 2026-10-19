// Extração HTML → texto e escolha do `quote` com a página fictícia em fixtures
// (nenhuma pessoa/obra/valor do fixture é real).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPage, parseClaimReviews } from "../src/lib/html";
import { buildFactcheckRow, canonicalUrl, claimFromTitle } from "../src/factchecks/normalize";
import { selectQuote } from "../src/factchecks/quote";

const html = readFileSync(join(import.meta.dirname, "fixtures/checagem_ficticia.html"), "utf8");
const URL_ = "https://checagem.exemplo.org/2030/03/ponte-vila-imaginaria";

describe("extractPage", () => {
  const page = extractPage(html, URL_);

  it("fica com o texto do artigo, sem navegação/rodapé", () => {
    expect(page.text).toContain("Segundo os dados do Portal de Obras do Estado Imaginário");
    expect(page.text).not.toContain("Todos os direitos reservados");
    expect(page.text).not.toContain("Leia também");
    expect(page.text).not.toContain("Início");
  });

  it("preserva parágrafos como linhas", () => {
    const lines = page.text.split("\n").filter(Boolean);
    expect(lines.some((l) => l.startsWith("O contrato original"))).toBe(true);
  });

  it("lê ClaimReview do JSON-LD (inclusive dentro de @graph) e a data", () => {
    expect(page.claimReviews).toHaveLength(1);
    expect(page.claimReviews[0]).toMatchObject({
      ratingText: "Falso",
      claimReviewed: "A ponte de Vila Imaginária custou R$ 9 bilhões aos cofres públicos",
      claimAuthor: "Deputado Fulano de Tal",
    });
    expect(page.publishedAt).toBe("2030-03-14T10:00:00-03:00");
  });

  it("JSON-LD malformado não derruba", () => {
    expect(parseClaimReviews(["{ quebrado", '{"@type":["ClaimReview"],"reviewRating":{"name":"Enganoso"}}'])).toEqual([
      { claimReviewed: null, ratingText: "Enganoso", datePublished: null, claimAuthor: null, url: null },
    ]);
  });
});

describe("[RF15] [RF05] selectQuote / buildFactcheckRow", () => {
  const page = extractPage(html, URL_);

  it("o quote é trecho LITERAL do corpo e sustenta o veredito", () => {
    const q = selectQuote({ body: page.text, claimText: page.claimReviews[0]!.claimReviewed, rating: "Falso" });
    expect(q).not.toBeNull();
    expect(page.text.includes(q!.quote)).toBe(true);
    expect(q!.quote).toMatch(/R\$ 412 milhões|informação é falsa/);
  });

  it("não escolhe a própria afirmação nem texto sem relação", () => {
    expect(selectQuote({ body: "Texto curto sem nada.", claimText: "x", rating: "Falso" })).toBeNull();
    const body = "A ponte custou R$ 9 bilhões aos cofres públicos segundo o post.\nOutra frase qualquer sobre o tempo de hoje à tarde.";
    const q = selectQuote({ body, claimText: "A ponte custou R$ 9 bilhões aos cofres públicos segundo o post.", rating: "Falso" });
    expect(q?.quote).not.toBe("A ponte custou R$ 9 bilhões aos cofres públicos segundo o post.");
  });

  it("monta a linha de kb_factchecks com rating do JSON-LD", () => {
    const r = buildFactcheckRow({ url: URL_ }, page);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row).toMatchObject({
      url: URL_,
      source_name: "checagem.exemplo.org",
      claim_text: "A ponte de Vila Imaginária custou R$ 9 bilhões aos cofres públicos",
      rating_original: "Falso",
      verdict: "contradito",
      person: null,
      published_at: "2030-03-14T00:00:00.000Z",
    });
    expect(r.row.body.includes(r.row.quote)).toBe(true);
  });

  it("rating do candidato (ex.: Google) tem prioridade sobre o da página", () => {
    const r = buildFactcheckRow({ url: URL_, ratingOriginal: "Enganoso", claimText: "Ponte custou 9 bi" }, page);
    expect(r.ok && r.row.verdict).toBe("impreciso");
  });

  it("sem rating em lugar nenhum ⇒ descarta", () => {
    const semRating = { ...page, claimReviews: [], text: page.text.replace("Classificação: Falso", "") };
    expect(buildFactcheckRow({ url: URL_, title: "Ponte de Vila Imaginária" }, semRating)).toEqual({ ok: false, reason: "sem_rating" });
  });

  it("corpo curto ⇒ descarta", () => {
    expect(buildFactcheckRow({ url: URL_ }, { ...page, text: "curto" })).toEqual({ ok: false, reason: "sem_corpo" });
  });

  it("afirmação a partir do título", () => {
    expect(claimFromTitle("É falso que vacina altera DNA")).toBe("Vacina altera DNA");
    expect(claimFromTitle("Enganoso: vídeo antigo")).toBe("Vídeo antigo");
  });

  it("URL canônica remove utm, fragmento e barra final", () => {
    expect(canonicalUrl("https://A.org/x/?utm_source=t&id=2#topo")).toBe("https://a.org/x/?id=2");
    expect(canonicalUrl("https://a.org/x/")).toBe("https://a.org/x");
  });
});
