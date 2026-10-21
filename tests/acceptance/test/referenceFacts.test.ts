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
    await db.query(`insert into ref_eleicoes (id, ano, turno, candidato, partido, votos, pct_validos, fonte_nome, fonte_url, trecho)
                    values ('e', 2022, 2, 'C', 'P', 1, 50, 'TSE', 'https://www.tse.jus.br/x', 't')`);
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
        `insert into ref_mandatos (id, pessoa, partido, inicio, fim, papel, fonte_nome, fonte_url, trecho)
         values ('x' || md5(random()::text), 'P', 'PT', '2003-01-01', $1, 'titular', 'F', $2, $3)`, [fim, url, trecho]);
    await expect(ins("2002-01-01")).rejects.toThrow();
    await expect(ins(null, "ftp://x")).rejects.toThrow();
    await expect(ins(null, undefined, " ")).rejects.toThrow();
    await ins(null);
    expect((await one<{ n: number }>(db, `select count(*)::int as n from ref_mandatos where pessoa = 'P'`)).n).toBeGreaterThan(0);
  });
});
