import { describe, expect, it } from "vitest";
import { mapRating, ratingFromLabel, ratingFromTitle, RATING_TABLE } from "../src/factchecks/rating";

describe("[RF15] mapRating — tabela explícita", () => {
  const cases: [string, string][] = [
    ["Falso", "contradito"],
    ["FALSO", "contradito"],
    ["Falsa", "contradito"],
    ["#FAKE", "contradito"],
    ["É #FAKE", "contradito"],
    ["Montagem", "contradito"],
    ["Enganoso", "impreciso"],
    ["enganosa", "impreciso"],
    ["Distorcido", "impreciso"],
    ["Exagerado", "impreciso"],
    ["Sem contexto", "impreciso"],
    ["Fora de contexto", "impreciso"],
    ["Impreciso", "impreciso"],
    ["Subestimado", "impreciso"],
    ["Verdadeiro, mas", "impreciso"],
    ["Verdadeiro mas", "impreciso"],
    ["Parcialmente falso", "impreciso"],
    ["#NÃO É BEM ASSIM", "impreciso"],
    ["#NÃOÉBEMASSIM", "impreciso"],
    ["É #NÃOÉBEMASSIM", "impreciso"],
    ["NÃOÉBEMASSIM", "impreciso"],
    ["Verdadeiro", "confirmado"],
    ["#FATO", "confirmado"],
    ["Comprovado", "confirmado"],
    ["Insustentável", "inconclusivo"],
    ["Contraditório", "inconclusivo"],
    ["De olho", "inconclusivo"],
    ["Ainda é cedo para dizer", "inconclusivo"],
    ["Sátira", "inconclusivo"],
    ["Contextualizando", "inconclusivo"],
  ];
  it.each(cases)("%s → %s", (rating, verdict) => {
    expect(mapRating(rating)).toBe(verdict);
  });

  it("ratings longos usam o prefixo, do mais específico ao mais geral", () => {
    expect(mapRating("Falso. O vídeo é de 2018 e foi editado.")).toBe("contradito");
    expect(mapRating("Enganoso: o dado é real, mas de outro ano")).toBe("impreciso");
    // selo que chega como slug do feed: 25 checagens da base ficaram em inconclusivo por isso
    expect(mapRating("não_é_bem_assim")).toBe("impreciso");
    expect(mapRating("parcialmente-falso")).toBe("impreciso");
    expect(mapRating("meia-verdade")).toBe("impreciso");
    expect(mapRating("fora_de_contexto")).toBe("impreciso");
    // selo do g1 grudado, como sai na página: o prefixo não cai na trava de "não"
    expect(mapRating("#NÃOÉBEMASSIM. O dado é de 2019")).toBe("impreciso");
    expect(mapRating("É #NÃOÉBEMASSIM: o programa começou antes")).toBe("impreciso");
    // "não é falso" segue em inconclusivo, com separador ou sem
    expect(mapRating("não_é_falso")).toBe("inconclusivo");
    expect(mapRating("Verdadeiro, mas o número caiu desde então")).toBe("impreciso");
    expect(mapRating("Parcialmente falso — parte do gráfico é inventada")).toBe("impreciso");
    expect(mapRating("Verdadeiro.")).toBe("confirmado");
  });

  it("na dúvida, inconclusivo", () => {
    expect(mapRating(undefined)).toBe("inconclusivo");
    expect(mapRating("")).toBe("inconclusivo");
    expect(mapRating("Mixture")).toBe("inconclusivo");
    expect(mapRating("Requer atenção")).toBe("inconclusivo");
    expect(mapRating("Não é falso nem verdadeiro")).toBe("inconclusivo");
  });

  it("toda entrada da tabela mapeia para si mesma", () => {
    for (const [k, v] of Object.entries(RATING_TABLE)) expect(mapRating(k)).toBe(v);
  });
});

describe("rating no título e em rótulo", () => {
  it("formatos de título das agências", () => {
    expect(ratingFromTitle("É falso que vacina causa X")).toBe("falso");
    expect(ratingFromTitle("É #FAKE que governo vai taxar Pix")).toBe("#FAKE");
    expect(ratingFromTitle("Enganoso: vídeo mistura imagens")).toBe("Enganoso");
    expect(ratingFromTitle("Verdadeiro, mas — dado é de 2022")).toBe("Verdadeiro, mas");
    expect(ratingFromTitle("Governo anuncia programa")).toBeNull();
    expect(ratingFromTitle("Falsos médicos presos")).toBeNull();
  });
  it("linha de classificação no texto", () => {
    expect(ratingFromLabel("blá\nClassificação: Falso\nfim")).toBe("Falso");
    expect(ratingFromLabel("Etiqueta: Enganoso")).toBe("Enganoso");
    expect(ratingFromLabel("Classificação: indicativa livre")).toBeNull();
  });
  it("[RF15] várias linhas de rótulo com selos diferentes (matéria com várias falas) ⇒ null; o mesmo selo repetido vale", () => {
    expect(ratingFromLabel("fala 1\nClassificação: Falso\nfala 2\nClassificação: Exagerado\nfim")).toBeNull();
    expect(ratingFromLabel("Selo: Falso\ntexto\nEtiqueta: Verdadeiro")).toBeNull();
    // rótulo fora da tabela também é outro selo: na dúvida, nenhum
    expect(ratingFromLabel("Classificação: Falso\nClassificação: Verdadeiro em parte")).toBeNull();
    expect(ratingFromLabel("Classificação: Falso\ntexto\nCLASSIFICAÇÃO: falso.")).toBe("Falso");
  });
});
