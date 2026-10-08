import type { DbTransaction } from "@alfred/db";
import type { ZodType } from "zod";

/** `{ applied: false }` means the target row did not exist (`triageTagOverride`). */
export type MutatorResult = void | { applied: boolean };

export type MutatorRun<A> = (tx: DbTransaction, args: A, userId: string) => Promise<MutatorResult>;

/** Work the push handler runs after the transaction commits. */
export type MutatorFollowUp =
  /** The dispatcher's policy cache, on every instance (ADR-0034 amendment). */
  | { kind: "bustPolicyCache" }
  /** Sync the Gmail label after a tag override (rfc-triage-tags.md). */
  | { kind: "relabelThread"; sourceThreadId: string }
  /** Delete a removed thread's attachment objects from the bucket (ADR-0065). */
  | { kind: "cleanChatStorage"; threadId: string };

/** Schema and runner share one `A`, so parsed args reach `run()` without a cast. */
export interface RegisteredServerMutator<A> {
  args: ZodType<A>;
  run: MutatorRun<A>;
  /** Runs only after the savepoint commits and `didMutatorApply` is true. */
  followUp?: (userId: string, args: A) => MutatorFollowUp[];
}
