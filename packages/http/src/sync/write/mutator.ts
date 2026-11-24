import type { DbTransaction } from "@alfred/db";
import type { ZodType } from "zod";

/**
 * `{ applied: false }` means the target row did not exist (`triageTagOverride`, `chatThreadDelete`).
 * No follow-up runs. `followUps` is the work that only the mutator can name, for example the
 * obligations of a cancel in its transaction.
 */
export type MutatorResult =
  | void
  | { applied: false }
  | { applied: true; followUps?: MutatorFollowUp[] };

type MutatorRun<A> = (tx: DbTransaction, args: A, userId: string) => Promise<MutatorResult>;

/** Work the push handler runs after the transaction commits. */
export type MutatorFollowUp =
  /** The dispatcher's policy cache, on every instance (ADR-0034 amendment). */
  | { kind: "bustPolicyCache" }
  /** Sync the Gmail label after a tag override (rfc-triage-tags.md). */
  | { kind: "relabelThread"; sourceThreadId: string }
  /** The after-commit work of `deleteChatThreadInTx`: the side effects of its run cancels. */
  | { kind: "dischargeThreadDelete"; afterCommit: () => Promise<void> };

/** Schema and runner share one `A`, so parsed args reach `run()` without a cast. */
export interface RegisteredServerMutator<A> {
  args: ZodType<A>;
  run: MutatorRun<A>;
  /** Runs only after the savepoint commits and the result is not `{ applied: false }`. */
  followUp?: (userId: string, args: A) => MutatorFollowUp[];
}
