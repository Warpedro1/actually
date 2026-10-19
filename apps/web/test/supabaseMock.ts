// Mock mínimo do cliente Supabase: cada `from(tabela)` grava a cadeia de
// chamadas e, ao ser aguardado, devolve o que o handler da tabela responder.

export interface QueryCall {
  table: string;
  ops: { op: string; args: unknown[] }[];
}

export type Result = { data: unknown; error: unknown };
type Handler = (q: QueryCall) => Result;

export function createMockDb(handlers: Record<string, Handler>) {
  const calls: QueryCall[] = [];

  function resolve(q: QueryCall): Result {
    const h = handlers[q.table];
    if (!h) throw new Error(`mock sem handler para "${q.table}"`);
    return h(q);
  }

  function builder(table: string) {
    const q: QueryCall = { table, ops: [] };
    calls.push(q);
    const b: Record<string, unknown> = {};
    for (const op of ["select", "insert", "upsert", "update", "eq", "in", "gte", "order", "limit", "maybeSingle", "single"]) {
      b[op] = (...args: unknown[]) => {
        q.ops.push({ op, args });
        return b;
      };
    }
    b.then = (ok: (r: Result) => unknown, fail?: (e: unknown) => unknown) => {
      try {
        return Promise.resolve(resolve(q)).then(ok, fail);
      } catch (err) {
        return Promise.reject(err).then(ok, fail);
      }
    };
    return b;
  }

  const db = {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: unknown) => {
      const q: QueryCall = { table: `rpc:${fn}`, ops: [{ op: "rpc", args: [args] }] };
      calls.push(q);
      return Promise.resolve(resolve(q));
    },
  };
  return { db, calls };
}

/** Primeiro argumento da operação `op` na chamada. */
export function argOf(q: QueryCall | undefined, op: string): unknown {
  return q?.ops.find((o) => o.op === op)?.args[0];
}
