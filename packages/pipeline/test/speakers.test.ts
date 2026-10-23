// Falantes sem mapa (ensaio completo de 18/10, issue #6): o jornalista da Band (S9) ficou sem
// mapa e teve fala checada; depois de reconexão da captura TODOS os rótulos mudam (s2-…:Sn) e
// a mediação volta a ser voz sem mapa até o editor remapear.
import { describe, expect, it } from "vitest";
import type { ExtractionOutput } from "../src/extract";
import { createPipeline } from "../src/index";
import { isOnlyQuestions, prefilter } from "../src/prefilter";
import { fakeAnthropic, makeDeps, MemoryStore } from "./helpers";

// mapa confirmado do ensaio (sessão s1-7e221b)
const MAPA = [
  { speaker_label: "s1-7e221b:S1", person: "Mediação" },
  { speaker_label: "s1-7e221b:S2", person: "Mediação" },
  { speaker_label: "s1-7e221b:S4", person: "Flávio Bolsonaro" },
  { speaker_label: "s1-7e221b:S5", person: "Lula" },
];

// trecho 628 do ensaio, S9 (jornalista da Band na "sala digital"): só pergunta, mas com "1º"
const PERGUNTA_S9 =
  "o MEI, quem aprovou mudanças recentes nessa nessa regulamentação, e a gente vai agora para para o gráfico de perguntas não é, aqui o que a gente está vendo são algumas perguntas mais buscadas desde a votação do 1º turno, no Brasil não é?";

function setup(speakerMap: { speaker_label: string; person: string }[]) {
  const store = new MemoryStore();
  store.speakerMap = speakerMap;
  const extract = (): { output: ExtractionOutput } => ({ output: { claims: [] } });
  const anthropic = fakeAnthropic({ extract, verify: () => ({ error: new Error("não deveria verificar") }) });
  const deps = makeDeps({ store, anthropic });
  return { store, anthropic, deps, pipeline: createPipeline(deps) };
}

describe("[RF09] voz sem mapa que só pergunta não vai ao extrator", () => {
  it("pergunta do jornalista S9 (sem mapa, debate já mapeado) é pulada com log", async () => {
    expect(prefilter(PERGUNTA_S9).pass).toBe(true); // o número faz passar no pré-filtro
    const { store, anthropic, deps, pipeline } = setup(MAPA);
    const seg = store.addSegment(PERGUNTA_S9, { speaker_label: "s1-7e221b:S9" });
    expect(await pipeline.runPipeline(seg.id)).toMatchObject({ claims: 0, alerts: 0 });
    expect(anthropic.calls).toHaveLength(0);
    expect(deps.logs.find((l) => l.event === "unmapped_question_skipped")?.fields).toMatchObject({
      segment_id: seg.id, speaker_label: "s1-7e221b:S9",
    });
  });

  it("depois de reconexão (rótulo s2-… sem mapa), pergunta da mediação com número também é pulada", async () => {
    const { store, anthropic, pipeline } = setup(MAPA);
    const seg = store.addSegment("Candidato, o senhor vai manter o salário mínimo acima de 1.518 reais em 2027?", { speaker_label: "s2-7e221b:S1" });
    await pipeline.runPipeline(seg.id);
    expect(anthropic.calls).toHaveLength(0);
  });

  it("contraexemplo: candidato mapeado perguntando continua indo ao extrator", async () => {
    const { store, anthropic, deps, pipeline } = setup(MAPA);
    // Lula (S5) no bloco 2: pergunta com pressuposto factual
    const seg = store.addSegment("O que que você fez com 134000000? Foi para ajudar o seu irmão?", { speaker_label: "s1-7e221b:S5" });
    await pipeline.runPipeline(seg.id);
    expect(anthropic.calls.length).toBeGreaterThan(0);
    expect(deps.logs.some((l) => l.event === "unmapped_question_skipped")).toBe(false);
  });

  it("contraexemplo: voz sem mapa com afirmação continua indo ao extrator", async () => {
    const { store, anthropic, pipeline } = setup(MAPA);
    const seg = store.addSegment("No meu governo o desemprego caiu para 5,6% em 2025.", { speaker_label: "s2-7e221b:S5" });
    await pipeline.runPipeline(seg.id);
    expect(anthropic.calls.length).toBeGreaterThan(0);
  });

  it("debate ainda sem mapa, ou mapa fora do ar: a pergunta segue como antes", async () => {
    const empty = setup([]);
    const a = empty.store.addSegment(PERGUNTA_S9, { speaker_label: "s1-7e221b:S9" });
    await empty.pipeline.runPipeline(a.id);
    expect(empty.anthropic.calls.length).toBeGreaterThan(0);

    const down = setup(MAPA);
    down.store.failing.add("getSpeakerMap");
    const b = down.store.addSegment(PERGUNTA_S9, { speaker_label: "s1-7e221b:S9" });
    await down.pipeline.runPipeline(b.id);
    expect(down.anthropic.calls.length).toBeGreaterThan(0);
  });

  it("só pergunta = toda frase termina em \"?\"", () => {
    expect(isOnlyQuestions("Milei Ordão?")).toBe(true);
    expect(isOnlyQuestions("E aí? Quanto custou, 3 bilhões?")).toBe(true);
    expect(isOnlyQuestions("você. Potou em você? Você não")).toBe(false);
    expect(isOnlyQuestions("Quem criou o Bolsa Família? Fui eu, em 2003.")).toBe(false);
    expect(isOnlyQuestions("")).toBe(false);
    // limite conhecido: a lista de perguntas lida pelo S9 no trecho 825 saiu sem "?" na transcrição
    expect(isOnlyQuestions("a gente vê algumas perguntas como o SUS foi criado em qual governo, se Flávio Bolsonaro não é, candidato da oposição quer privatizar o SUS,")).toBe(false);
  });
});
