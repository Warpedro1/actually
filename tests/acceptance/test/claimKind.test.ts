// Tipo da fala em claims (migration 20261021000011): só os tipos julgáveis
// entram; promessa e opinião pura nem chegam ao banco.
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, one, seedVerification, type Db } from "./db";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
});

describe("[RF02] claims.kind", () => {
  it("[RF02] afirmação antiga ou sem tipo vira \"fato\"; opinião mensurável guarda o dado que a mede", async () => {
    const s = await seedVerification(db);
    expect(await one(db, `select kind, measurable from claims where id = $1`, [s.claim])).toEqual({ kind: "fato", measurable: null });
    const r = await one<{ kind: string; measurable: string }>(db,
      `insert into claims (debate_id, segment_id, text_original, text_normalized, claim_hash, kind, measurable)
       values ($1, $2, 'b', 'b', 'h-kind', 'opiniao_mensuravel', 'consumo de carne por pessoa') returning kind, measurable`,
      [s.debate, s.segment]);
    expect(r).toEqual({ kind: "opiniao_mensuravel", measurable: "consumo de carne por pessoa" });
  });

  it("[RF02] promessa e opinião pura são recusadas pelo banco", async () => {
    const s = await seedVerification(db);
    for (const kind of ["promessa", "opiniao", "qualquer"]) {
      await expect(db.query(
        `insert into claims (debate_id, segment_id, text_original, text_normalized, claim_hash, kind)
         values ($1, $2, 'c', 'c', $3, $4)`, [s.debate, s.segment, `h-${kind}`, kind])).rejects.toThrow();
    }
  });
});
