import type { DbTransaction } from "@alfred/db";

export interface ServerMutatorCtx {
  userId: string;
}

// The push handler runs every mutator inside its outer transaction's savepoint,
// so a mutator's executor is always a `DbTransaction`, never a pooled `db()`
// handle. Typing it as such makes handing a pool to a mutator (re-forking the
// transaction, breaking atomicity) a compile error at the call site. A body that
// re-imports `db()` itself stays a code-review concern — the type only guards the
// executor that is passed in.
export type DbTx = DbTransaction;

/**
 * Shape every server mutator must conform to. `args: never` lets each concrete
 * mutator keep its own precise arg type while still satisfying the map
 * constraint in `./index`. Paired with `satisfies Record<MutatorName, ServerMutator>`
 * on `serverMutators`, this makes a client mutator with no server impl a
 * compile error instead of a silent runtime drop in `push.ts`.
 *
 * Do NOT "fix" `args: never` to `unknown`: `never` is what lets 25 heterogeneous
 * argument types satisfy one record.
 */
export type ServerMutator = (tx: DbTx, args: never, ctx: ServerMutatorCtx) => Promise<unknown>;
