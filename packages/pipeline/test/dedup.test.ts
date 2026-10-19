import { DEFAULT_SETTINGS } from "@actually/db";
import { describe, expect, it } from "vitest";
import { dedupAndRecord, findOriginal, type DedupArgs } from "../src/dedup";
import { claimHash } from "../src/normalize";
import { insertAlertSafe } from "../src/publish";
import type { ExtractedClaim } from "../src/types";
import { DEBATE_ID, fakeAnthropic, fakeVector, makeDeps, MemoryStore } from "./helpers";

const noLLM = fakeAnthropic({
  extract: () => ({ error: new Error("não deveria chamar") }),
  verify: () => ({ error: new Error("não deveria chamar") }),
});

const claim = (text: string): ExtractedClaim => ({
  text_original: text, text_normalized: text, topic: "economia", numbers: [], indicator: null, time_reference: null,
});

const SEG = { id: 1, speaker_label: "SPEAKER_1", t_end: 18 };

/** Grava uma afirmação "original" já verificada (com alerta opcional). */
async function seedOriginal(store: MemoryStore, text: string, alertStatus: "published" | "pending_review" | "rejected" | null, embedding = fakeVector(text)) {
  const { id: claimId } = await store.insertClaim({
    debate_id: DEBATE_ID, segment_id: 1, speaker_label: "SPEAKER_1", text_original: text, text_normalized: text,
    claim_hash: claimHash(text), numbers: [], topic: "economia", indicator: null, embedding, duplicate_of: null,
  });
  const ver = await store.insertVerification({
    claim_id: claimId, verdict: "contradito", correction: "Segundo o IBGE, foi 7,8%.", model_confidence: 0.95,
    final_score: 0.9, score_components: {}, layer: "L2", model: "x", latency_ms: {},
  });
  await store.insertEvidence([{
    verification_id: ver.id, evidence_type: "indicator", url: "https://sidra.ibge.gov.br/tabela/4099",
    source_name: "IBGE", source_tier: 1, quote: "Série X: 2023 = 7,8 %", quote_verified: true, published_at: null,
  }]);
  let alertId: string | null = null;
  if (alertStatus) {
    ({ id: alertId } = await store.insertAlert({
      debate_id: DEBATE_ID, claim_id: claimId, verification_id: ver.id, verdict: "contradito", status: alertStatus,
      claim_text: text, summary: "Desocupação foi 7,8%.", correction: "Segundo o IBGE, foi 7,8%.", speaker_label: "SPEAKER_1",
      is_repeat: false, repeat_of: null, segment_t_end: 18,
    }));
  }
  return { claimId, verificationId: ver.id, alertId };
}

function args(text: string, embedding: number[] | null = fakeVector(text)): DedupArgs {
  return { debate_id: DEBATE_ID, segment: SEG, claim: claim(text), hash: claimHash(text), embedding, settings: DEFAULT_SETTINGS };
}

describe("trava de repetição", () => {
  it("mesmo hash no debate ⇒ duplicata, reusa a verificação e cria alerta de repetição", async () => {
    const store = new MemoryStore();
    const deps = makeDeps({ store, anthropic: noLLM });
    const orig = await seedOriginal(store, "O desemprego em 2023 foi de 12%.", "published");
    const out = await dedupAndRecord(deps, args("o desemprego em 2023 foi de 12%"));
    expect(out).toMatchObject({ kind: "duplicate", via: "hash", original_claim_id: orig.claimId, verification_id: orig.verificationId });
    const repeat = store.alerts.find((a) => a.is_repeat)!;
    expect(repeat).toMatchObject({
      is_repeat: true, repeat_of: orig.alertId, verification_id: orig.verificationId, status: "published", verdict: "contradito",
    });
    expect(store.claims.at(-1)!.duplicate_of).toBe(orig.claimId);
  });

  it("repetição herda o status da original (pending_review) e não repete alerta rejeitado", async () => {
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

  it("similaridade alta + mesmos números ⇒ duplicata", async () => {
    const store = new MemoryStore();
    const vec = fakeVector("desemprego 2023 12%");
    const orig = await seedOriginal(store, "O desemprego foi de 12% em 2023.", "published", vec);
    const deps = makeDeps({ store, anthropic: noLLM });
    const out = await dedupAndRecord(deps, args("Em 2023, a taxa de desemprego chegou a 12%.", vec));
    expect(out).toMatchObject({ kind: "duplicate", via: "similarity", original_claim_id: orig.claimId });
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

describe("publish: trigger do banco", () => {
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
