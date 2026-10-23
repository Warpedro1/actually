// Aviso público e procedência da checagem (migration 20261023000016). As duas
// colunas são escritas pelo /admin direto na tabela, pelo navegador, então o
// limite de tamanho e a lista de valores têm de valer no banco — não no React.
import { beforeEach, describe, expect, it } from "vitest";
import { asRole, freshDb, one, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

const newDebate = (slug = "d-aviso") =>
  one<{ id: string; public_note: string | null; check_mode: string | null }>(
    db,
    `insert into debates (slug, title) values ($1, 'D') returning id, public_note, check_mode`,
    [slug],
  );

describe("[RF10] observação pública e procedência da checagem", () => {
  it("[RF10] debate novo nasce sem aviso e sem procedência: a página não afirma nada", async () => {
    const d = await newDebate();
    expect(d.public_note).toBeNull();
    expect(d.check_mode).toBeNull();
  });

  it("[RF10] o público lê o aviso e a procedência de um debate público", async () => {
    const d = await newDebate();
    await db.query(`update debates set public_note = $2, check_mode = 'post' where id = $1`, [
      d.id,
      "A checagem não foi rodada ao vivo.",
    ]);
    const seen = await asRole(db, "anon", null, async () =>
      (await db.query(`select public_note, check_mode from debates where id = $1`, [d.id])).rows,
    );
    expect(seen).toEqual([{ public_note: "A checagem não foi rodada ao vivo.", check_mode: "post" }]);
  });

  it("[RF10] aviso maior que 500 caracteres é recusado pelo banco", async () => {
    const d = await newDebate();
    await expect(
      db.query(`update debates set public_note = $2 where id = $1`, [d.id, "x".repeat(501)]),
    ).rejects.toThrow(/public_note/);
    // no limite, passa
    await db.query(`update debates set public_note = $2 where id = $1`, [d.id, "x".repeat(500)]);
  });

  it("[RF10] procedência só aceita os três casos reais (ou nulo)", async () => {
    const d = await newDebate();
    for (const mode of ["live", "post", "mixed", null]) {
      await db.query(`update debates set check_mode = $2 where id = $1`, [d.id, mode]);
    }
    await expect(db.query(`update debates set check_mode = 'talvez' where id = $1`, [d.id])).rejects.toThrow(/check_mode/);
  });

  it("[RNF05] anônimo não escreve aviso nem procedência", async () => {
    const d = await newDebate();
    const rows = await asRole(db, "anon", null, async () =>
      (await db.query(`update debates set public_note = 'texto do anônimo' where id = $1 returning id`, [d.id])).rows,
    );
    expect(rows).toHaveLength(0);
    expect((await newDebate("d2")).public_note).toBeNull();
    const after = await one<{ public_note: string | null }>(db, `select public_note from debates where id = $1`, [d.id]);
    expect(after.public_note).toBeNull();
  });
});
