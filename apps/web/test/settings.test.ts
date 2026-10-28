import { DEFAULT_SETTINGS, resolveSettings, type DebateSettings } from "@actually/db";
import { describe, expect, it } from "vitest";
import { confirmMessages, expectedFor, hitlTurnedOff, saveSettingsPatch, settingsPatch, webSearchTurnedOff } from "@/lib/staff/settings";
import { argOf, createMockDb, type QueryCall } from "./supabaseMock";

/**
 * Banco simulado com a semântica de set_debate_settings (migration
 * 20261019000006): settings = settings || patch, recusado com 40001 se alguma
 * chave do patch não tem mais o valor que a aba leu. A semântica real é
 * testada no Postgres em tests/acceptance/test/settings.requirements.test.ts.
 */
function fakeDb(initial: Partial<DebateSettings>) {
  const state = { settings: { ...initial } as Record<string, unknown> };
  const mock = createMockDb({
    "rpc:set_debate_settings": (q: QueryCall) => {
      const { p_patch, p_expected } = argOf(q, "rpc") as { p_patch: Record<string, unknown>; p_expected: Record<string, unknown> };
      const stale = Object.keys(p_expected).filter((k) => (state.settings[k] ?? null) !== p_expected[k]);
      if (stale.length > 0) return { data: null, error: { code: "40001", message: "conflito", details: stale.sort().join(",") } };
      state.settings = { ...state.settings, ...p_patch };
      return { data: state.settings, error: null };
    },
  });
  return { ...mock, state };
}

/** Uma aba do /admin: guarda o que leu e salva o que o editor mudou a partir disso. */
function tab(read: Partial<DebateSettings>) {
  const raw = { ...read };
  const base = resolveSettings(raw);
  return {
    save: (db: unknown, edit: Partial<DebateSettings>) =>
      saveSettingsPatch(db as never, "d1", raw, settingsPatch(base, { ...base, ...edit })),
  };
}

describe("[RF07] [RF08] settings do debate gravadas por patch", () => {
  it("[RF07] patch só com as chaves alteradas", () => {
    const base = resolveSettings({});
    expect(settingsPatch(base, { ...base })).toEqual({});
    expect(settingsPatch(base, { ...base, t_red: 0.9, show_attribution: true })).toEqual({ t_red: 0.9, show_attribution: true });
  });

  it("[RF07] valor esperado é o que a aba leu do banco; chave ausente vira null", () => {
    expect(expectedFor({ t_red: 0.88 }, { t_red: 0.9, t_yellow: 0.8 })).toEqual({ t_red: 0.88, t_yellow: null });
  });

  it("[RF07] envia só o patch e o valor lido, nunca o objeto inteiro", async () => {
    const db = fakeDb({ ...DEFAULT_SETTINGS });
    const r = await tab({ ...DEFAULT_SETTINGS }).save(db.db, { t_red: 0.9 });
    expect(r.status).toBe("saved");
    expect(argOf(db.calls[0], "rpc")).toEqual({ p_debate_id: "d1", p_patch: { t_red: 0.9 }, p_expected: { t_red: 0.85 } });
    expect(db.calls.some((c) => c.table === "debates")).toBe(false);
  });

  it("[RF07] dois salvamentos concorrentes de chaves diferentes preservam ambas", async () => {
    const db = fakeDb({ ...DEFAULT_SETTINGS });
    const a = tab({ ...DEFAULT_SETTINGS });
    const b = tab({ ...DEFAULT_SETTINGS });
    const [ra, rb] = await Promise.all([a.save(db.db, { t_red: 0.9 }), b.save(db.db, { show_attribution: true })]);
    expect([ra.status, rb.status]).toEqual(["saved", "saved"]);
    expect(db.state.settings).toMatchObject({ t_red: 0.9, show_attribution: true, require_red_approval: true });
  });

  it("[RF08] aba obsoleta mexendo em outra chave não desliga o HITL ligado em outra sessão", async () => {
    const stale = tab({ ...DEFAULT_SETTINGS, require_red_approval: false });
    const db = fakeDb({ ...DEFAULT_SETTINGS, require_red_approval: true });
    const r = await stale.save(db.db, { t_red: 0.9 });
    expect(r.status).toBe("saved");
    expect(db.state.settings).toMatchObject({ t_red: 0.9, require_red_approval: true });
  });

  it("[RF08] mesma chave mudada em outra sessão: conflito, nada gravado", async () => {
    const db = fakeDb({ ...DEFAULT_SETTINGS });
    const a = tab({ ...DEFAULT_SETTINGS });
    const b = tab({ ...DEFAULT_SETTINGS });
    expect((await a.save(db.db, { t_red: 0.9 })).status).toBe("saved");
    const r = await b.save(db.db, { t_red: 0.95, require_red_approval: false });
    expect(r).toEqual({ status: "conflict", keys: ["t_red"] });
    expect(db.state.settings).toMatchObject({ t_red: 0.9, require_red_approval: true });
  });

  it("[RF08] nada alterado: não chama o banco", async () => {
    const db = fakeDb({});
    expect(await tab({}).save(db.db, {})).toEqual({ status: "unchanged" });
    expect(db.calls).toHaveLength(0);
  });

  it("[RF08] desligar o HITL dos vermelhos pede confirmação explícita, além do resumo das mudanças", () => {
    const base = resolveSettings({});
    const off = { require_red_approval: false };
    expect(hitlTurnedOff(off)).toEqual(["require_red_approval"]);
    const msgs = confirmMessages(base, off, { require_red_approval: "Revisão humana dos vermelhos (HITL)" });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toContain("Revisão humana dos vermelhos (HITL): ligado → desligado");
    expect(msgs[1]).toMatch(/DESLIGAR a revisão humana dos VERMELHOS/);

    // Ligar o HITL ou mexer em outra chave: só o resumo.
    expect(confirmMessages(base, { require_yellow_approval: true })).toHaveLength(1);
    const t = confirmMessages(base, { t_red: 0.9 }, { t_red: "Limiar dos vermelhos (t_red)" });
    expect(t).toHaveLength(1);
    expect(t[0]).toContain("Limiar dos vermelhos (t_red): 0.85 → 0.9");
  });

  it("[RF07] busca na web ligada por padrão, inclusive em debate antigo sem a chave", () => {
    expect(DEFAULT_SETTINGS.web_search).toBe(true);
    expect(resolveSettings({ t_red: 0.9 }).web_search).toBe(true);
  });

  it("[RF07] debate antigo sem a chave: desligar a busca manda só web_search, com valor esperado null", async () => {
    const db = fakeDb({ t_red: 0.75 });
    const r = await tab({ t_red: 0.75 }).save(db.db, { web_search: false });
    expect(r.status).toBe("saved");
    expect(argOf(db.calls[0], "rpc")).toEqual({ p_debate_id: "d1", p_patch: { web_search: false }, p_expected: { web_search: null } });
    expect(db.state.settings).toEqual({ t_red: 0.75, web_search: false });
  });

  it("[RF07] desligar a busca na web: resumo e aviso de cobertura menor, num diálogo só", () => {
    const base = resolveSettings({});
    expect(webSearchTurnedOff({ web_search: false })).toBe(true);
    expect(webSearchTurnedOff({ web_search: true })).toBe(false);
    const msgs = confirmMessages(base, { web_search: false }, { web_search: "Busca na web" });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("Busca na web: ligado → desligado");
    expect(msgs[0]).toMatch(/base de conhecimento passa a ser a única fonte/);
    expect(msgs[0]).toMatch(/observação pública/);
    // religar: só o resumo, sem o aviso
    const on = confirmMessages(resolveSettings({ web_search: false }), { web_search: true }, { web_search: "Busca na web" });
    expect(on).toHaveLength(1);
    expect(on[0]).toContain("Busca na web: desligado → ligado");
    expect(on[0]).not.toMatch(/única fonte/);
  });
});
