// Banco falso em memória com o pedaço do cliente do Supabase que a carga usa:
// from(t).select/insert/upsert/update/delete com eq/in/is, single/maybeSingle; rpc.
// Tabelas são arrays; RPCs são funções do teste; `failOn` simula erro numa linha.
import type { Ctx } from "../src/lib/ctx";

export type Row = Record<string, unknown>;
type Op = "select" | "insert" | "upsert" | "update" | "delete";
type Result = { data: unknown; error: { message: string } | null };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  rpcs: Record<string, (args: Record<string, unknown>, db: FakeDb) => unknown> = {};
  rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  /** Erro simulado: mensagem para (tabela, operação, linha), ou null. */
  failOn?: (table: string, op: Op, row: Row) => string | null;
  private seq = 0;

  constructor(init: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(init)) this.tables[t] = rows.map((r) => ({ ...r }));
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  nextId(): string {
    return `id-${++this.seq}`;
  }

  from(table: string): Query {
    return new Query(this, table);
  }

  async rpc(fn: string, args: Record<string, unknown>): Promise<Result> {
    this.rpcCalls.push({ fn, args });
    const f = this.rpcs[fn];
    if (!f) return { data: null, error: { message: `função ${fn} não existe` } };
    try {
      return { data: await f(args, this), error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  }
}

class Query implements PromiseLike<Result> {
  private op: Op = "select";
  private payload: Row[] = [];
  private onConflict = "id";
  private filters: ((r: Row) => boolean)[] = [];
  private mode: "many" | "single" | "maybe" = "many";
  private max: number | undefined;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(_cols?: string): this {
    return this;
  }
  insert(rows: Row | Row[]): this {
    this.op = "insert";
    this.payload = [rows].flat();
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = [rows].flat();
    this.onConflict = opts?.onConflict ?? "id";
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.payload = [patch];
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, v: unknown): this {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  in(col: string, vs: unknown[]): this {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  is(col: string, v: unknown): this {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  order(): this {
    return this;
  }
  limit(n: number): this {
    this.max = n;
    return this;
  }
  /** Só a primeira página (os testes não passam de 1000 linhas). */
  range(from: number, to: number): this {
    this.max = to - from + 1;
    return this;
  }
  single(): this {
    this.mode = "single";
    return this;
  }
  maybeSingle(): this {
    this.mode = "maybe";
    return this;
  }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return Promise.resolve()
      .then(() => this.run())
      .then(ok, fail);
  }

  private run(): Result {
    const rows = this.db.rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    const fail = (op: Op, r: Row) => this.db.failOn?.(this.table, op, r) ?? null;
    const out: Row[] = [];
    switch (this.op) {
      case "select":
        out.push(...rows.filter(match).slice(0, this.max));
        break;
      case "insert":
        for (const p of this.payload) {
          const e = fail("insert", p);
          if (e) return { data: null, error: { message: e } };
          const r = { id: this.db.nextId(), ...p };
          rows.push(r);
          out.push(r);
        }
        break;
      case "upsert": {
        const keys = this.onConflict.split(",");
        for (const p of this.payload) {
          const e = fail("upsert", p);
          if (e) return { data: null, error: { message: e } };
          const found = rows.find((r) => keys.every((k) => r[k] === p[k]));
          if (found) {
            Object.assign(found, p);
            out.push(found);
          } else {
            const r = { id: this.db.nextId(), ...p };
            rows.push(r);
            out.push(r);
          }
        }
        break;
      }
      case "update":
        for (const r of rows.filter(match)) {
          const e = fail("update", r);
          if (e) return { data: null, error: { message: e } };
          Object.assign(r, this.payload[0]);
          out.push(r);
        }
        break;
      case "delete":
        out.push(...rows.filter(match));
        this.db.tables[this.table] = rows.filter((r) => !match(r));
        break;
    }
    const data = out.map((r) => ({ ...r }));
    if (this.mode === "single") {
      return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: `esperava 1 linha, veio ${data.length}` } };
    }
    if (this.mode === "maybe") return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }
}

/** Contexto de etapa com o banco falso e o log em memória. */
export function testCtx(db: FakeDb | null): { ctx: Ctx; logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  const fmt = (a: unknown[]) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  const ctx: Ctx = {
    dryRun: false,
    verbose: false,
    db: db as never,
    log: (...a) => logs.push(fmt(a)),
    warn: (...a) => warns.push(fmt(a)),
  };
  return { ctx, logs, warns };
}
