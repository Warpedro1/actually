// Fatos de referência (migration 20261021000012): mandatos e eleições curados,
// lidos só pelo pipeline (service role).
import { beforeEach, describe, expect, it } from "vitest";
import { asRole, freshDb, one, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

describe("[RNF05] [RF03] fatos de referência", () => {
  it("[RNF05] anon e usuário logado não leem as tabelas de referência", async () => {
    expect((await one<{ n: number }>(db, `select count(*)::int as n from ref_eleicoes`)).n).toBeGreaterThan(0);
    for (const role of ["anon", "authenticated"] as const) {
      for (const table of ["ref_mandatos", "ref_eleicoes"]) {
        await expect(asRole(db, role, null, () => db.query(`select * from ${table}`)), `${role} em ${table}`)
          .rejects.toThrow(/permission denied/);
      }
    }
  });

  it("[RF03] mandato exige fonte http(s), trecho e fim depois do início", async () => {
    const ins = (fim: string | null, url = "https://www.biblioteca.presidencia.gov.br/x", trecho = "t") =>
      db.query(
        `insert into ref_mandatos (id, pessoa, partido, inicio, fim, papel, fonte_nome, fonte_url, trecho, conferencia)
         values ('x' || md5(random()::text), 'P', 'PT', '2003-01-01', $1, 'titular', 'F', $2, $3, 'teste')`, [fim, url, trecho]);
    await expect(ins("2002-01-01")).rejects.toThrow();
    await expect(ins(null, "ftp://x")).rejects.toThrow();
    await expect(ins(null, undefined, " ")).rejects.toThrow();
    await ins(null);
    expect((await one<{ n: number }>(db, `select count(*)::int as n from ref_mandatos where pessoa = 'P'`)).n).toBeGreaterThan(0);
  });

  it("[RF03] dados semeados: mandatos em sequência, sem buraco nem sobreposição, e só o último em curso", async () => {
    const rows = (await db.query<{ inicio: string; fim: string | null }>(
      `select inicio::text, fim::text from ref_mandatos where id not like 'x%' order by inicio`)).rows;
    expect(rows.length).toBe(9);
    expect(rows[0]!.inicio).toBe("1995-01-01");
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.inicio).toBe(rows[i - 1]!.fim);
    expect(rows.filter((r) => r.fim === null)).toHaveLength(1);
  });

  it("[RF03] dados semeados: percentuais de cada turno somam no máximo 100% e cada turno tem candidato", async () => {
    const turns = (await db.query<{ ano: number; turno: number; soma: string; n: number }>(
      `select ano, turno, sum(pct_validos)::text as soma, count(*)::int as n from ref_eleicoes group by 1, 2 order by 1, 2`)).rows;
    expect(turns.map((t) => `${t.ano}-${t.turno}`)).toEqual(["2018-1", "2018-2", "2022-1", "2022-2", "2026-1"]);
    for (const t of turns) expect(Number(t.soma)).toBeLessThanOrEqual(100.01);
    const second = turns.filter((t) => t.turno === 2);
    for (const t of second) expect(Number(t.soma)).toBeCloseTo(100, 1);
  });
});
