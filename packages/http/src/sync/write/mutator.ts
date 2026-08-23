import type { DbTransaction } from "@alfred/db";
import type { ZodType } from "zod";

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

/** Signature of one server mutator's executor, generic over its validated args. */
export type MutatorRun<A> = (tx: DbTx, args: A, ctx: ServerMutatorCtx) => Promise<unknown>;

/**
 * Post-commit work a mutator hands back to the push handler. The DB write
 * commits inside the push transaction; these descriptors describe everything
 * that must happen after the transaction lands (external IO, cross-instance
 * cache busts). The push handler owns execution order and failure policy; the
 * entry owns extracting the payload from its own validated args.
 */
export type MutatorFollowUp =
  /** Drop the dispatcher's in-process policy cache across all instances (ADR-0034 amendment). */
  | { kind: "bustPolicyCache" }
  /** Reconcile a thread's Gmail label after a user tag override (rfc-triage-tags.md). */
  | { kind: "relabelThread"; sourceThreadId: string }
  /** Reap a deleted chat thread's attachment objects from the bucket (ADR-0065). */
  | { kind: "cleanChatStorage"; threadId: string };

/**
 * One registry entry pairing a mutator's arg schema with its executor under a
 * single `A`. That shared variable is what keeps push dispatch correlated:
 * indexing the registry by one name yields schema and runner typed by the same
 * `A`, so `safeParse().data` flows into `run()` without casts or re-reads.
 *
 * The `args` field also makes schema/impl drift a compile error at the
 * registry: a runner whose declared args do not match its registered schema's
 * output fails assignment there, not at push time.
 */
export interface RegisteredServerMutator<A> {
  args: ZodType<A>;
  run: MutatorRun<A>;
  /**
   * Harvested from validated args after the savepoint commits AND applied
   * (per `didMutatorApply`). Returns the post-commit work for this mutation;
   * omit when a mutator needs none.
   */
  followUp?: (userId: string, args: A) => MutatorFollowUp[];
}
