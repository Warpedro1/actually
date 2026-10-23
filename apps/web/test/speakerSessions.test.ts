import { describe, expect, it } from "vitest";
import {
  formatSpeech,
  groupSpeakerSessions,
  sessionOf,
  type SpeakerSegmentRow,
} from "@/lib/staff/speakerSessions";

/**
 * Ensaio completo de 18/10: a diarização devolveu 11 rótulos para 4 pessoas. Parte veio de
 * fragmentos de 1–2 s ("1.", "Olá,", "Ok.") e parte de reconexão da captura, que reinicia a
 * numeração — o mapa do /editor mostrava mais vozes do que gente no debate.
 */
const seg = (
  id: number,
  label: string,
  text: string,
  t: number,
  dur: number,
  received: string,
): SpeakerSegmentRow => ({
  id,
  speaker_label: label,
  text,
  t_start: t,
  // numeric do Postgres pode chegar como string
  t_end: String(t + dur),
  received_at: received,
});

const A = "2026-10-18T22:10:00Z";
const B = "2026-10-18T23:30:00Z";

describe("[RF09] mapa de falantes agrupado por sessão de captura", () => {
  it("fragmento curto sai da lista de vozes; a pessoa continua com uma voz só", () => {
    const rows = [
      seg(1, "s1-7e221b:S4", "Eu vou te mostrar os números.", 10, 30, A),
      seg(2, "s1-7e221b:S5", "O país cresceu 7,5% em 2010.", 45, 25, A),
      seg(3, "s1-7e221b:S6", "1.", 71, 0.4, A),
      seg(4, "s1-7e221b:S7", "Ok.", 72, 0.6, A),
      seg(5, "s1-7e221b:S8", "Olá,", 73, 1.2, A),
    ];
    const { sessions } = groupSpeakerSessions(rows, {
      "s1-7e221b:S4": "Flávio Bolsonaro",
      "s1-7e221b:S5": "Lula",
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.voices.map((v) => v.label)).toEqual(["s1-7e221b:S4", "s1-7e221b:S5"]);
    expect(sessions[0]!.fragments.map((v) => v.label)).toEqual([
      "s1-7e221b:S6",
      "s1-7e221b:S7",
      "s1-7e221b:S8",
    ]);
    expect(sessions[0]!.voices[0]).toMatchObject({ segments: 1, speech_s: 30, person: "Flávio Bolsonaro" });
  });

  it("a soma da fala e a última frase vêm de todos os trechos do rótulo", () => {
    const rows = [
      seg(1, "s1-x:S4", "primeira", 0, 4, A),
      seg(2, "s1-x:S4", "última", 10, 4, B),
    ];
    const { sessions } = groupSpeakerSessions(rows, {});
    expect(sessions[0]!.voices[0]).toMatchObject({ segments: 2, speech_s: 8, sample: "última", last_at: B });
  });

  it("reconexão cria outra sessão; a mais recente vem primeiro e pede remapeamento", () => {
    const rows = [
      seg(1, "s1-7e221b:S4", "fala longa do candidato", 10, 40, A),
      seg(2, "s1-7e221b:S5", "resposta do outro", 60, 40, A),
      // depois da reconexão os mesmos dois viram s2-…:S0 e S1, sem mapa
      seg(3, "s2-9f1c42:S0", "continuando o debate depois da queda", 0, 35, B),
      seg(4, "s2-9f1c42:S1", "e eu respondo o seguinte", 40, 30, B),
    ];
    const view = groupSpeakerSessions(rows, {
      "s1-7e221b:S4": "Flávio Bolsonaro",
      "s1-7e221b:S5": "Lula",
    });
    expect(view.sessions.map((s) => s.session)).toEqual(["s2-9f1c42", "s1-7e221b"]);
    expect(view.sessions[0]!.latest).toBe(true);
    expect(view.sessions[1]!.latest).toBe(false);
    // o mapa antigo não vale para os rótulos novos: o editor precisa remapear
    expect(view.sessions[0]!.voices.every((v) => v.person === null)).toBe(true);
    expect(view.remap).toBe(true);
  });

  it("sem mapa nenhum, ou com a sessão nova já mapeada, não pede remapeamento", () => {
    const rows = [seg(1, "s1-x:S4", "fala longa sem mapa", 0, 40, A)];
    expect(groupSpeakerSessions(rows, {}).remap).toBe(false);
    expect(groupSpeakerSessions(rows, { "s1-x:S4": "Lula" }).remap).toBe(false);
  });

  it("voz curta sem mapa na sessão nova não pede remapeamento (só a partir de 20 s)", () => {
    const rows = [
      seg(1, "s1-a:S4", "fala antiga mapeada", 0, 40, A),
      seg(2, "s2-b:S0", "oi, tudo bem?", 0, 8, B),
    ];
    expect(groupSpeakerSessions(rows, { "s1-a:S4": "Lula" }).remap).toBe(false);
  });

  it("rótulo mapeado sem trecho carregado continua na lista, para dar para desfazer o mapa", () => {
    const { sessions } = groupSpeakerSessions([], { "s1-y:S2": "Mediação" });
    expect(sessions[0]!.fragments).toMatchObject([{ label: "s1-y:S2", person: "Mediação", segments: 0 }]);
  });

  it("rótulo sem prefixo de sessão fica no grupo vazio", () => {
    expect(sessionOf("S3")).toBe("");
    expect(sessionOf("s1-7e221b:S3")).toBe("s1-7e221b");
    const { sessions } = groupSpeakerSessions([seg(1, "S3", "fala antiga", 0, 20, A)], {});
    expect(sessions[0]!.session).toBe("");
  });

  it("tempo de fala: décimo de segundo abaixo de 10 s, formato de duração acima", () => {
    expect(formatSpeech(0.42)).toBe("0,4 s");
    expect(formatSpeech(8.05)).toBe("8,1 s");
    expect(formatSpeech(81)).toMatch(/^1\s*min/);
  });
});
