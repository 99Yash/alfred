import type { UserSettings } from "@alfred/assistant/settings";
import type { TriageClassification } from "./classify";
import type { TriageDocumentContext } from "./store";
import type { TriageRunReason } from "./workflow-input";

/**
 * Whether a classify run mints its rail todo (ADR-0050), with the reads that decide it.
 * The classify step and the backfill dry-run both call this, so a replay keeps
 * production's reads, precedence and read-failure policy.
 *
 * The classifier's todo rubric left with slice 3; slice 7 returns todos as a follow-up
 * workflow with its own prompt. The lane mints nothing until then, and the signature
 * stays so a replay keeps the call shape.
 */

/** Why a proposed todo is not minted, in precedence order. */
type TriageTodoSuppression = { kind: "gate"; reason: string } | { kind: "action_items_off" };

export type TriageTodoOutcome =
  | { kind: "none" }
  | { kind: "mint"; todo: { name: string; assist?: string } }
  | {
      kind: "suppressed";
      todo: { name: string; assist?: string };
      suppression: TriageTodoSuppression;
    };

/**
 * The whole-thread closure read. Only a reply run reads it, because a reply run may
 * retract an older live todo even when it proposes none (ADR-0050).
 * `userAlreadyReplied` (newest message is the user's) gates the retraction.
 * `documentRepliedAfter` (the user replied after THIS message) gates the mint.
 * They differ once a newer inbound exists, so the mint cannot use the first.
 */
export type TriageThreadClosureRead =
  | { kind: "not_read" }
  | { kind: "read"; userAlreadyReplied: boolean; documentRepliedAfter: boolean }
  /** Fails open: the todo stays mintable and `close-loop-todos` retracts nothing. */
  | { kind: "read_failed"; error: unknown };

export type TriageTodoDecision = {
  outcome: TriageTodoOutcome;
  closure: TriageThreadClosureRead;
};

/** The todo lane's decision for this run. It mints nothing until slice 7 rebuilds the lane. */
export async function decideTriageTodo(args: {
  userId: string;
  /** The same user's bind. The caller's step bind, so the zone shares its flag load. */
  settings: UserSettings;
  sourceThreadId: string;
  /** Only `reply` reads the thread closure. */
  reason: TriageRunReason | undefined;
  classification: TriageClassification;
  document: Pick<
    TriageDocumentContext["document"],
    "accountId" | "title" | "content" | "authoredAt" | "metadata"
  >;
  actionItemsEnabled: boolean;
}): Promise<TriageTodoDecision> {
  // The classifier's todo rubric left with slice 3; slice 7 returns todos as a follow-up
  // workflow with its own prompt. The lane mints nothing until then, and it keeps the
  // signature so a backfill replay keeps the call shape.
  void args;

  return { outcome: { kind: "none" }, closure: { kind: "not_read" } };
}
