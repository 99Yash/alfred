import type { UserSettings } from "@alfred/assistant/settings";
import type { ActiveStandingInstruction, ReportedStandingInstructionSet } from "../knowledge";
import type { TriageClassification } from "./classify";
import type { StandingInstructionMatch } from "./floors";
import { deriveEffectiveTriage, type EffectiveTriage, type EffectiveTriageRow } from "./effective";
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
export type TriageTodoSuppression =
  /**
   * A matched `block_todo_suggestion` on a row with no model verdict (ADR-0060). The floor did
   * not run on that row, so its cached todo is still there and the lane blocks it here.
   */
  | { kind: "standing_instruction_matched"; match: StandingInstructionMatch }
  /** ADR-0113 rule 4: a `block_todo_suggestion` instruction is `unknown`, so the todo waits. */
  | { kind: "standing_instruction_unknown"; instructions: ActiveStandingInstruction[] }
  /** Fails closed: an unknown instruction must not mint a todo the user blocked. */
  | { kind: "standing_instruction_read_failed"; error: unknown }
  | { kind: "gate"; reason: string }
  | { kind: "action_items_off" };

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

/**
 * The instruction read of the todo lane. On a row with a model verdict, a matched
 * `block_todo_suggestion` already cleared the todo in the effective result. A row with no
 * verdict keeps its cached todo, so the lane also blocks a matched one (`todoBlockedBy`).
 */
export type TriageTodoStanding =
  | { kind: "loaded"; effective: EffectiveTriage }
  | { kind: "read_failed"; error: unknown };

/** The `block_todo_suggestion` state, for the decision trace. `none` when no todo is proposed. */
export type TriageTodoStandingRead =
  | { kind: "none" }
  | { kind: "blocked"; match: StandingInstructionMatch }
  | { kind: "waiting"; instructions: ActiveStandingInstruction[] }
  | { kind: "read_failed"; error: unknown };

export type TriageTodoDecision = {
  outcome: TriageTodoOutcome;
  standingSuppression: TriageTodoStandingRead;
  closure: TriageThreadClosureRead;
};

/** The triage result the todo lane decides on, for the document of this run. */
export type TodoTriageResult = EffectiveTriageRow & { documentId: string };

/**
 * Derive the todo lane's instruction state from the triage result it decides on. The
 * classify step passes what it stores, so the derivation repeats its own floor; a reused
 * row derives again from its stored verdict under the current instructions.
 */
export function triageTodoStanding(args: {
  suppressions: ReportedStandingInstructionSet;
  sender: string | null;
  accountId: string | null;
  triage: TodoTriageResult;
}): TriageTodoStanding {
  const instructions = args.suppressions.forMail({
    sender: args.sender,
    accountId: args.accountId,
  });

  if (instructions.kind === "read_failed") return instructions;

  return {
    kind: "loaded",
    effective: deriveEffectiveTriage({
      triage: args.triage,
      documentId: args.triage.documentId,
      instructions,
    }),
  };
}

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
  isColdContact: boolean;
  actionItemsEnabled: boolean;
  /** From {@link triageTodoStanding} over the step's one `"report"` load, so both lanes agree. */
  standing: TriageTodoStanding;
}): Promise<TriageTodoDecision> {
  // The classifier's todo rubric left with slice 3; slice 7 returns todos as a follow-up
  // workflow with its own prompt. The lane mints nothing until then, and it keeps the
  // signature so a backfill replay keeps the call shape.
  void args;

  return {
    outcome: { kind: "none" },
    standingSuppression: { kind: "none" },
    closure: { kind: "not_read" },
  };
}
