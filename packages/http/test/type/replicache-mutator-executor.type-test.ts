// Tier-1 negative-type fixture guarding the Replicache push-mutator executor
// (campaign knowledge-settings-phase4 item 14). Every server mutator runs inside
// the push handler's outer transaction's savepoint, so its executor is a
// `DbTransaction`, never a pooled `db()` handle (`DbRoot`). `server-mutators`'
// `type DbTx` is what enforces that: it flows into `ServerMutator` and every
// `tx: DbTx` mutator method, so `Parameters<typeof serverMutators.prefSet>[0]`
// exposes exactly the executor a caller must supply. The one way that guarantee
// silently erodes: someone widens `DbTx` back to `any` (its pre-#688 state) to
// "make an error go away", which would re-accept a pooled `db()` handle and let a
// future mutator re-fork the push transaction, breaking its atomicity — with no
// compile error.
//
// This file is that guarantee's machine detector. It is compile-only: the
// node:test glob is `test/**/*.test.ts`, so a `.type-test.ts` never runs; it is
// type-checked solely by `packages/api/tsconfig.test.json` (wired into
// `check-types`). If a future widening makes a `DbRoot` compile as the executor,
// the `@ts-expect-error` directive below becomes unused and `tsc` fails with
// TS2578 — the regression turns the build red.

import type { DbRoot, DbTransaction } from "@alfred/db";
import type { serverMutators } from "../../src/sync/write";

// The executor every server mutator receives — the type the narrowed `DbTx`
// alias resolves to at the `prefSet` call surface.
type MutatorExecutor = Parameters<typeof serverMutators.prefSet>[0];

// `declare const` is ambient, so `noUnusedLocals`/`noUnusedParameters` never fire
// on these; the `export const` fixtures below are exported for the same reason
// (matching the established `.type-test.ts` idiom in this package).
declare const tx: DbTransaction;
declare const root: DbRoot;

// POSITIVE — the real push savepoint executor (`DbTransaction`) is exactly what a
// mutator expects. This proves the negative below fails for the RIGHT reason (the
// executor is tx-shaped), not because `MutatorExecutor` degenerated to `never`.
export const _ok: MutatorExecutor = tx;

// NEGATIVE — a pooled `db()` handle (`DbRoot`) must NOT be assignable to the
// mutator executor. This is the detector for a future re-widening of `DbTx` to
// `any`: that makes `MutatorExecutor` accept anything, `root` becomes assignable,
// the directive goes unused, and `tsc` fails with TS2578.
// @ts-expect-error a pooled `db()` handle (DbRoot) must not be handed to a mutator (guards re-widening `DbTx` back to `any`)
export const _bad: MutatorExecutor = root;
