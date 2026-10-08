// Compile-only fixture: a server mutator runs in the push transaction's savepoint, so its
// executor must be `DbTransaction`. A pooled `db()` handle (`DbRoot`) would fork the push
// transaction and break its atomicity. Widen `MutatorRun`'s `tx` and the directive below goes unused.

import type { DbRoot, DbTransaction } from "@alfred/db";
import type { serverMutators } from "../../src/sync/write";

type MutatorExecutor = Parameters<(typeof serverMutators.prefSet)["run"]>[0];

// `declare const` is ambient, so `noUnusedLocals` ignores it.
declare const tx: DbTransaction;

declare const root: DbRoot;

// Proves the negative fails for the right reason, not because the type became `never`.
export const _ok: MutatorExecutor = tx;

// @ts-expect-error a pooled `db()` handle (DbRoot) must not be handed to a mutator (guards re-widening `DbTx` back to `any`)
export const _bad: MutatorExecutor = root;
