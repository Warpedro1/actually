import { DEFAULT_SETTINGS, type Alert, type DebateSettings } from "@actually/db";
import { describe, expect, it } from "vitest";
import { dedupAndRecord, findOriginal, ORIGINAL_IN_PROGRESS_MS, type DedupArgs } from "../src/dedup";
import { claimHash } from "../src/normalize";
import { insertAlertSafe, publishRepeat } from "../src/publish";
import type { ExtractedClaim } from "../src/types";
import { DEBATE_ID, fakeAnthropic, fakeVector, makeDeps, MemoryStore } from "./helpers";

/** Outro debate no mesmo banco (ex.: o ensaio de 22/10 reproduzindo o debate de 18/10). */
const OTHER_DEBATE_ID = "00000000-0000-4000-8000-000000000002";

const noLLM = fakeAnthropic({
  extract: () => ({ error: new Error("não deveria chamar") }),
  verify: () => ({ error: new Error("não deveria chamar") }),
});

const claim = (text: string): ExtractedClaim => ({
  text_original: text, text_normalized: text, topic: "economia", numbers: [], indicator: null, time_reference: null,
});

const SEG = { id: 1, speaker_label: "SPEAKER_1", t_end: 18 };

/** Grava uma afirmação "original" já verificada (com alerta opcional). */
async function seedOriginal(
  store: MemoryStore, text: string, alertStatus: "published" | "pending_review" | "rejected" | null, embedding = fakeVector(text),
  opts: { debateId?: string; verdict?: "contradito" | "impreciso" } = {},
) {
  const debateId = opts.debateId ?? DEBATE_ID;
  const verdict = opts.verdict ?? "contradito";
  const { id: claimId } = await store.insertClaim({
    debate_id: debateId, segment_id: 1, speaker_label: "SPEAKER_1", text_original: text, text_normalized: text,
    claim_hash: claimHash(text), numbers: [], topic: "economia", indicator: null, embedding, duplicate_of: null,
  });
  const ver = await store.insertVerification({
    claim_id: claimId, verdict, correction: "Segundo o IBGE, foi 7,8%.", model_confidence: 0.95,
    final_score: 0.9, score_components: {}, layer: "L2", model: "x", latency_ms: {},
  });
  await store.insertEvidence([{
    verification_id: ver.id, evidence_type: "indicator", url: "https://sidra.ibge.gov.br/tabela/4099",
    source_name: "IBGE", source_tier: 1, quote: "Série X: 2023 = 7,8 %", quote_verified: true, published_at: null,
  }]);
  let alertId: string | null = null;
  if (alertStatus) {
    ({ id: alertId } = await store.insertAlert({
      debate_id: debateId, claim_id: claimId, verification_id: ver.id, verdict, status: alertStatus,
      claim_text: text, summary: "Desocupação foi 7,8%.", correction: "Segundo o IBGE, foi 7,8%.", speaker_label: "SPEAKER_1",
      is_repeat: false, repeat_of: null, segment_t_end: 18,
    }));
  }
  return { claimId, verificationId: ver.id, alertId };
}

/** Original gravada cuja verificação não terminou (em andamento, erro, timeout ou sem evidência). */
async function seedUnverified(store: MemoryStore, text: string) {
  const { id } = await store.insertClaim({
    debate_id: DEBATE_ID, segment_id: 1, speaker_label: "SPEAKER_1", text_original: text, text_normalized: text,
    claim_hash: claimHash(text), numbers: [], topic: "economia", indicator: null, embedding: fakeVector(text), duplicate_of: null,
  });
  return id;
}

/** Store que também informa o created_at da original no caminho por hash. */
class AgedStore extends MemoryStore {
  override async findClaimByHash(debateId: string, hash: string) {
    const m = await super.findClaimByHash(debateId, hash);
    if (!m) return null;
    return { ...m, created_at: this.claims.find((c) => c.id === m.claim_id)!.created_at };
  }
}

function args(text: string, embedding: number[] | null = fakeVector(text), settings: Partial<DebateSettings> = {}): DedupArgs {
  return {
    debate_id: DEBATE_ID, segment: SEG, claim: claim(text), hash: claimHash(text), embedding,
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

describe("[RF06] trava de repetição", () => {
  it("mesmo hash no debate ⇒ duplicata, reusa a verificação e cria alerta de repetição", async () => {
    const store = new MemoryStore();
    const deps = makeDeps({ store, anthropic: noLLM });
    const orig = await seedOriginal(store, "O desemprego em 2023 foi de 12%.", "published");
    const out = await dedupAndRecord(deps, args("o desemprego em 2023 foi de 12%", undefined, { require_red_approval: false }));
    expect(out).toMatchObject({ kind: "duplicate", via: "hash", original_claim_id: orig.claimId, verification_id: orig.verificationId });
    const repeat = store.alerts.find((a) => a.is_repeat)!;
    expect(repeat).toMatchObject({
      is_repeat: true, repeat_of: orig.alertId, verification_id: orig.verificationId, status: "published", verdict: "contradito",
    });
    expect(store.claims.at(-1)!.duplicate_of).toBe(orig.claimId);
  });

  it("original pendente ⇒ repetição pendente; original rejeitada ⇒ nenhuma repetição", async () => {
    const store = new MemoryStore();
    const deps = makeDeps({ store, anthropic: noLLM });
    await seedOriginal(store, "A Selic chegou a 15% em 2025.", "pending_review");
    await dedupAndRecord(deps, args("A Selic chegou a 15% em 2025."));
    expect(store.alerts.filter((a) => a.is_repeat).map((a) => a.status)).toEqual(["pending_review"]);

    const store2 = new MemoryStore();
    await seedOriginal(store2, "A Selic chegou a 15% em 2025.", "rejected");
    const out = await dedupAndRecord(makeDeps({ store: store2, anthropic: noLLM }), args("A Selic chegou a 15% em 2025."));
    expect(out).toMatchObject({ kind: "duplicate", repeat_alert: null });
    expect(store2.alerts.filter((a) => a.is_repeat)).toHaveLength(0);
  });

  it("original sem alerta (confirmado/inconclusivo) ⇒ duplicata silenciosa", async () => {
    const store = new MemoryStore();
    await seedOriginal(store, "O PIB cresceu 3,4% em 2024.", null);
    const out = await dedupAndRecord(makeDeps({ store, anthropic: noLLM }), args("O PIB cresceu 3,4% em 2024."));
    expect(out).toMatchObject({ kind: "duplicate", repeat_alert: null });
    expect(store.alerts).toHaveLength(0);
  });

  it("similaridade alta + mesma redação (só a grafia do número muda) ⇒ duplicata", async () => {
    const store = new MemoryStore();
    const vec = fakeVector("desemprego 2023 12%");
    const orig = await seedOriginal(store, "O desemprego foi de 12% em 2023.", "published", vec);
    const deps = makeDeps({ store, anthropic: noLLM });
    const out = await dedupAndRecord(deps, args("O desemprego foi de 12 por cento em 2023.", vec));
    expect(out).toMatchObject({ kind: "duplicate", via: "similarity", original_claim_id: orig.claimId });
  });

  it("similaridade alta + paráfrase com outras palavras ⇒ verifica de novo (nunca reusa veredito de outra redação)", async () => {
    const store = new MemoryStore();
    const vec = fakeVector("desemprego 2023 12%");
    await seedOriginal(store, "O desemprego foi de 12% em 2023.", "published", vec);
    const out = await dedupAndRecord(makeDeps({ store, anthropic: noLLM }), args("Em 2023, a taxa de desemprego chegou a 12%.", vec));
    expect(out.kind).toBe("new");
    expect(store.alerts.filter((a) => a.is_repeat)).toHaveLength(0);
  });

  it("NUNCA junta números diferentes, mesmo com embedding idêntico", async () => {
    const store = new MemoryStore();
    const vec = fakeVector("desemprego");
    await seedOriginal(store, "O desemprego foi de 6% em 2023.", "published", vec);
    const deps = makeDeps({ store, anthropic: noLLM });
    expect(await findOriginal(deps, DEBATE_ID, claim("O desemprego foi de 8% em 2023."), claimHash("O desemprego foi de 8% em 2023."), vec, DEFAULT_SETTINGS)).toBeNull();
    // período diferente também não
    expect(await findOriginal(deps, DEBATE_ID, claim("O desemprego foi de 6% em 2022."), claimHash("x"), vec, DEFAULT_SETTINGS)).toBeNull();
    // direção oposta também não
    await seedOriginal(store, "O desmatamento caiu no governo.", "published", fakeVector("desmatamento governo"));
    expect(await findOriginal(deps, DEBATE_ID, claim("O desmatamento aumentou no governo."), claimHash("y"), fakeVector("desmatamento governo"), DEFAULT_SETTINGS)).toBeNull();
    const out = await dedupAndRecord(deps, args("O desemprego foi de 8% em 2023.", vec));
    expect(out.kind).toBe("new");
  });

  it("similaridade abaixo de dedup_similarity ⇒ nova", async () => {
    const store = new MemoryStore();
    await seedOriginal(store, "O desemprego foi de 12% em 2023.", "published");
    const out = await dedupAndRecord(makeDeps({ store, anthropic: noLLM }), args("A inflação de 2023 ficou em 12% segundo o governo anterior."));
    expect(out.kind).toBe("new");
  });

  it("corrida: 23505 no insert ⇒ trata como duplicata da vencedora", async () => {
    const store = new MemoryStore();
    const text = "O salário mínimo é de R$ 1.518.";
    store.beforeInsertClaim = (row) => {
      // outra invocação grava o mesmo hash entre a busca e o nosso insert
      if (!row.duplicate_of && !store.claims.length) {
        store.claims.push({ ...row, id: "claim-winner", created_at: new Date().toISOString() });
      }
    };
    const out = await dedupAndRecord(makeDeps({ store, anthropic: noLLM }), args(text));
    expect(out).toMatchObject({ kind: "duplicate", via: "race", original_claim_id: "claim-winner", verification_id: null, repeat_alert: null });
    expect(store.claims.map((c) => c.duplicate_of)).toEqual([null, "claim-winner"]);
  });

  it("busca da trava fora do ar ⇒ segue como nova (índice único ainda protege)", async () => {
    const store = new MemoryStore();
    store.failing.add("findClaimByHash");
    const deps = makeDeps({ store, anthropic: noLLM });
    const out = await dedupAndRecord(deps, args("O PIB cresceu 3,4% em 2024."));
    expect(out.kind).toBe("new");
    expect(deps.logs.some((l) => l.event === "dedup_lookup_failed")).toBe(true);
  });
});

describe("[RF06] [RF08] repetição respeita o HITL do debate atual", () => {
  it("original publicada com o HITL desligado; editor liga require_red_approval ⇒ repetição entra pendente", async () => {
    const store = new MemoryStore();
    await seedOriginal(store, "O desemprego em 2023 foi de 12%.", "published");
    const out = await dedupAndRecord(makeDeps({ store, anthropic: noLLM }), args("O desemprego em 2023 foi de 12%.", undefined, { require_red_approval: true }));
    expect(out).toMatchObject({ kind: "duplicate", via: "hash", repeat_alert: { status: "pending_review" } });
    expect(store.alerts.filter((a) => a.is_repeat).map((a) => a.status)).toEqual(["pending_review"]);
    expect(store.alerts.some((a) => a.is_repeat && a.published_at)).toBe(false);
  });

  it("amarelo segue require_yellow_approval do debate atual", async () => {
    for (const [requireYellow, expected] of [[true, "pending_review"], [false, "published"]] as const) {
      const store = new MemoryStore();
      await seedOriginal(store, "A Selic chegou a 15% em 2025.", "published", undefined, { verdict: "impreciso" });
      await dedupAndRecord(makeDeps({ store, anthropic: noLLM }), args("A Selic chegou a 15% em 2025.", undefined, { require_yellow_approval: requireYellow }));
      expect(store.alerts.filter((a) => a.is_repeat)).toEqual([expect.objectContaining({ verdict: "impreciso", status: expected })]);
    }
  });

  it("original ainda pendente nunca gera repetição publicada, mesmo com o HITL desligado", async () => {
    const store = new MemoryStore();
    await seedOriginal(store, "A Selic chegou a 15% em 2025.", "pending_review");
    await dedupAndRecord(makeDeps({ store, anthropic: noLLM }), args("A Selic chegou a 15% em 2025.", undefined, {
      require_red_approval: false, require_yellow_approval: false,
    }));
    expect(store.alerts.filter((a) => a.is_repeat).map((a) => a.status)).toEqual(["pending_review"]);
  });

  it("afirmação já publicada em OUTRO debate (ensaio) não é repetição: segue como nova e é verificada de novo", async () => {
    const store = new MemoryStore();
    const vec = fakeVector("desemprego 2023 12%");
    await seedOriginal(store, "O desemprego foi de 12% em 2023.", "published", vec, { debateId: OTHER_DEBATE_ID });
    const deps = makeDeps({ store, anthropic: noLLM });
    // a RPC devolve a afirmação do outro debate (alerta publicado lá)...
    expect(await store.matchVerifiedClaims(DEBATE_ID, vec, DEFAULT_SETTINGS.dedup_similarity, 5)).toHaveLength(1);
    // ...mas a trava não a reaproveita, nem com o HITL desligado
    const out = await dedupAndRecord(deps, args("O desemprego foi de 12% em 2023.", vec, {
      require_red_approval: false, require_yellow_approval: false,
    }));
    expect(out.kind).toBe("new");
    expect(store.claims.at(-1)).toMatchObject({ debate_id: DEBATE_ID, duplicate_of: null });
    expect(store.alerts.filter((a) => a.debate_id === DEBATE_ID)).toHaveLength(0);
  });

  it("publishRepeat recusa alerta de outro debate", async () => {
    const store = new MemoryStore();
    const deps = makeDeps({ store, anthropic: noLLM });
    const orig = await seedOriginal(store, "O desemprego foi de 12% em 2023.", "published", undefined, { debateId: OTHER_DEBATE_ID });
    const original = (await store.getAlert(orig.alertId!)) as Alert;
    const res = await publishRepeat(store, {
      debate_id: DEBATE_ID, claim_id: "c-nova", claim_text: "x", speaker_label: null, segment_t_end: null, original,
      settings: { require_red_approval: false, require_yellow_approval: false },
    }, deps.logger);
    expect(res).toBeNull();
    expect(store.alerts).toHaveLength(1);
    expect(deps.logs.some((l) => l.event === "repeat_other_debate_skipped")).toBe(true);
  });
});

describe("[RF06] trava por similaridade nunca junta afirmações opostas", () => {
  const PAIRS: [string, string][] = [
    ["O senador Flávio Bolsonaro votou a favor da PEC da Transição em 2022.", "O senador Flávio Bolsonaro votou contra a PEC da Transição em 2022."],
    ["O governo teve superávit primário em 2023.", "O governo teve déficit primário em 2023."],
    ["A Câmara aprovou a reforma tributária em 2023.", "A Câmara rejeitou a reforma tributária em 2023."],
    ["O deputado votou sim na reforma da Previdência em 2019.", "O deputado votou não na reforma da Previdência em 2019."],
    // trocas fora de qualquer lista de antônimos
    ["O Brasil exportou 1 milhão de barris de petróleo por dia em 2023.", "O Brasil importou 1 milhão de barris de petróleo por dia em 2023."],
    ["O candidato foi condenado em 2017.", "O candidato foi absolvido em 2017."],
    ["O governo comprou 10 mil vacinas em 2021.", "O governo vendeu 10 mil vacinas em 2021."],
    ["o pt votou pela pec em 2022.", "o pl votou pela pec em 2022."],
    ["O Brasil deve 10 bilhões à Venezuela.", "A Venezuela deve 10 bilhões ao Brasil."],
  ];
  it.each(PAIRS)("%s × %s ⇒ não é repetição, mesmo com embedding idêntico", async (first, second) => {
    const store = new MemoryStore();
    const vec = fakeVector("mesmo vetor");
    await seedOriginal(store, first, "published", vec);
    const deps = makeDeps({ store, anthropic: noLLM });
    expect(await findOriginal(deps, DEBATE_ID, claim(second), claimHash(second), vec, DEFAULT_SETTINGS)).toBeNull();
    const out = await dedupAndRecord(deps, args(second, vec, { require_red_approval: false }));
    expect(out.kind).toBe("new");
    expect(store.alerts.filter((a) => a.is_repeat)).toHaveLength(0);
  });

  it("menor x maior taxa da série (indicador min x max) ⇒ não é repetição", async () => {
    const store = new MemoryStore();
    const vec = fakeVector("mesmo vetor");
    const deps = makeDeps({ store, anthropic: noLLM });
    await seedOriginal(store, "Em 2024 o Brasil teve a menor taxa de desemprego da série histórica.", "published", vec);
    store.claims[0]!.indicator = { query: "desemprego", period: "2024", claimed_value: null, unit: "%", kind: "min" };
    const other: ExtractedClaim = {
      ...claim("Em 2024 o Brasil teve a maior taxa de desemprego da série histórica."),
      indicator: { query: "desemprego", period: "2024", claimed_value: null, unit: "%", kind: "max" },
    };
    expect(await findOriginal(deps, DEBATE_ID, other, claimHash(other.text_normalized), vec, DEFAULT_SETTINGS)).toBeNull();
  });
});

describe("[RF06] original sem verificação concluída não silencia as repetições", () => {
  it("store sem o horário da original ⇒ conta como em andamento: duplicata silenciosa, nunca verificação em paralelo", async () => {
    const store = new MemoryStore();
    const deps = makeDeps({ store, anthropic: noLLM, now: () => Date.now() + 3_600_000 });
    const origId = await seedUnverified(store, "O salário mínimo é de R$ 1.518.");
    const out = await dedupAndRecord(deps, args("O salário mínimo é de R$ 1.518."));
    expect(out).toMatchObject({ kind: "duplicate", via: "hash", original_claim_id: origId, verification_id: null, repeat_alert: null });
    expect(deps.logs.some((l) => l.event === "claim_retry_unverified_original")).toBe(false);
  });

  it("original sem verificação (erro/timeout/sem evidência) e fora do prazo ⇒ repetição gravada como duplicata, mas verificada de novo", async () => {
    const store = new AgedStore();
    const text = "O salário mínimo é de R$ 1.518.";
    const origId = await seedUnverified(store, text);
    const deps = makeDeps({ store, anthropic: noLLM, now: () => Date.now() + ORIGINAL_IN_PROGRESS_MS + 1_000 });
    const out = await dedupAndRecord(deps, args(text));
    expect(out).toMatchObject({ kind: "new", retry_of: origId });
    expect(store.claims.at(-1)!.duplicate_of).toBe(origId);
    expect(deps.logs.some((l) => l.event === "claim_retry_unverified_original")).toBe(true);
    // enquanto nenhuma tentativa concluir, a seguinte também (nada fica em silêncio para sempre)
    expect(await dedupAndRecord(deps, args(text))).toMatchObject({ kind: "new", retry_of: origId });
  });

  it("com o horário da original: em andamento (dentro do prazo) ⇒ duplicata silenciosa; depois do prazo ⇒ verifica de novo", async () => {
    const store = new AgedStore();
    const text = "O salário mínimo é de R$ 1.518.";
    const origId = await seedUnverified(store, text);
    const t0 = Date.parse(store.claims[0]!.created_at);
    const at = (ms: number) => makeDeps({ store, anthropic: noLLM, now: () => t0 + ms });

    const during = await dedupAndRecord(at(5_000), args(text));
    expect(during).toMatchObject({ kind: "duplicate", via: "hash", original_claim_id: origId, verification_id: null, repeat_alert: null });

    const after = await dedupAndRecord(at(ORIGINAL_IN_PROGRESS_MS + 1_000), args(text));
    expect(after).toMatchObject({ kind: "new", retry_of: origId });
    expect(ORIGINAL_IN_PROGRESS_MS).toBeLessThanOrEqual(60_000);
  });

  it("original verificada continua reaproveitada normalmente (sem nova verificação)", async () => {
    const store = new AgedStore();
    const orig = await seedOriginal(store, "O PIB cresceu 3,4% em 2024.", null);
    store.claims[0]!.created_at = new Date(Date.now() - 3_600_000).toISOString();
    const out = await dedupAndRecord(makeDeps({ store, anthropic: noLLM }), args("O PIB cresceu 3,4% em 2024."));
    expect(out).toMatchObject({ kind: "duplicate", via: "hash", verification_id: orig.verificationId });
  });
});

describe("[RF05] [RF08] publish: trigger do banco", () => {
  it("publicar sem evidência verificada ⇒ log de BUG e grava como pending_review", async () => {
    const store = new MemoryStore();
    const deps = makeDeps({ store, anthropic: noLLM });
    const ver = await store.insertVerification({
      claim_id: "c", verdict: "contradito", correction: "x", model_confidence: 1, final_score: 1,
      score_components: {}, layer: "L3", model: null, latency_ms: {},
    });
    const res = await insertAlertSafe(store, {
      debate_id: DEBATE_ID, claim_id: "c", verification_id: ver.id, verdict: "contradito", status: "published",
      claim_text: "x", summary: "x", correction: "x", speaker_label: null, is_repeat: false, repeat_of: null, segment_t_end: null,
    }, deps.logger);
    expect(res.status).toBe("pending_review");
    expect(store.alerts[0]!.status).toBe("pending_review");
    expect(deps.logs.find((l) => l.event === "BUG_publish_without_verified_evidence")?.level).toBe("error");
  });
});
