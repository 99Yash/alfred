import type { UserSettings } from "@alfred/assistant/settings";
import type { ActiveStandingInstruction, ReportedStandingInstructionSet } from "../knowledge";
import {
  resolveTodoSuggestion,
  todoSuppressionReason,
  type AssistDateAnchor,
  type ResolvedTodoSuggestion,
  type TodoSuppressionReason,
  type TriageClassification,
} from "./classify";
import {
  deriveEffectiveTriage,
  standingBlockWaitsOn,
  type EffectiveTriage,
  type EffectiveTriageRow,
} from "./effective";
import type { TriageDocumentContext } from "./store";
import { readGmailThreadClosure, userRepliedAfterMessage } from "./thread-state";
import type { TriageRunReason } from "./workflow-input";

/**
 * Whether a classify run mints its rail todo (ADR-0050), with the reads that decide it.
 * The classify step and the backfill dry-run both call this, so a replay keeps
 * production's reads, precedence and read-failure policy.
 */

/** Why a proposed todo is not minted, in precedence order. */
export type TriageTodoSuppression =
  /** ADR-0113 rule 4: a `block_todo_suggestion` instruction is `unknown`, so the todo waits. */
  | { kind: "standing_instruction_unknown"; instructions: ActiveStandingInstruction[] }
  /** Fails closed: an unknown instruction must not mint a todo the user blocked. */
  | { kind: "standing_instruction_read_failed"; error: unknown }
  | { kind: "gate"; reason: TodoSuppressionReason }
  | { kind: "action_items_off" };

export type TriageTodoOutcome =
  | { kind: "none" }
  | { kind: "mint"; todo: ResolvedTodoSuggestion }
  | { kind: "suppressed"; todo: ResolvedTodoSuggestion; suppression: TriageTodoSuppression };

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
 * The instruction read of the todo lane. A matched `block_todo_suggestion` already cleared
 * the todo in the effective result, so only an `unknown` one is left to decide here.
 */
export type TriageTodoStanding =
  | { kind: "loaded"; effective: EffectiveTriage }
  | { kind: "read_failed"; error: unknown };

/** The `block_todo_suggestion` state, for the decision trace. `none` when no todo is proposed. */
export type TriageTodoStandingRead =
  | { kind: "none" }
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

/** The classification with the effective category, ask, and todo of the current instructions. */
function effectiveClassification(
  classification: TriageClassification,
  standing: TriageTodoStanding,
): TriageClassification {
  const result = standing.kind === "loaded" ? standing.effective.result : null;

  if (!result) return classification;

  return {
    ...classification,
    category: result.category,
    documentAsk: result.documentAsk,
    todoSuggestion: result.todoSuggestion,
    todoDecision: result.todoDecision ?? undefined,
  };
}

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
  const { document } = args;
  const classification = effectiveClassification(args.classification, args.standing);

  // Read the zone only when a todo is proposed. The step bind usually holds it already.
  const assistDateAnchor: AssistDateAnchor | null =
    document.authoredAt && classification.todoSuggestion
      ? { sentAt: document.authoredAt, timezone: await args.settings.timezone() }
      : null;

  const todo = resolveTodoSuggestion(classification, assistDateAnchor);
  const closure = args.reason === "reply" ? await readClosure(args) : { kind: "not_read" as const };

  if (!todo) return { outcome: { kind: "none" }, standingSuppression: { kind: "none" }, closure };

  const waitingOn =
    args.standing.kind === "loaded"
      ? standingBlockWaitsOn(args.standing.effective, "block_todo_suggestion")
      : [];

  const standingSuppression: TriageTodoStandingRead =
    args.standing.kind === "read_failed"
      ? args.standing
      : waitingOn.length > 0
        ? { kind: "waiting", instructions: waitingOn }
        : { kind: "none" };

  const gateReason = todoSuppressionReason({
    sender: document.metadata.from ?? null,
    subject: document.title,
    signalText: [document.title, document.content, document.metadata.snippet ?? null]
      .filter(Boolean)
      .join("\n"),
    // Not persisted, so absent on a reused row; the tracker-sender regex covers that.
    collabActivity: classification.collabActivity ?? null,
    category: classification.category,
    isColdContact: args.isColdContact,
    // Per message on purpose. `observations.thread` and `newestDirection` both
    // read `sent` on a fresh inbound after an old reply and withheld its todo.
    userRepliedAfterMessage: closure.kind === "read" && closure.documentRepliedAfter,
  });

  const suppression: TriageTodoSuppression | null =
    standingSuppression.kind === "waiting"
      ? { kind: "standing_instruction_unknown", instructions: standingSuppression.instructions }
      : standingSuppression.kind === "read_failed"
        ? { kind: "standing_instruction_read_failed", error: standingSuppression.error }
        : gateReason
          ? { kind: "gate", reason: gateReason }
          : !args.actionItemsEnabled
            ? { kind: "action_items_off" }
            : null;

  return {
    outcome: suppression ? { kind: "suppressed", todo, suppression } : { kind: "mint", todo },
    standingSuppression,
    closure,
  };
}

async function readClosure(args: {
  userId: string;
  sourceThreadId: string;
  document: { authoredAt: Date | null };
}): Promise<TriageThreadClosureRead> {
  try {
    // Read the whole thread, so a fresh inbound after an old reply still counts as open.
    const closure = await readGmailThreadClosure({
      userId: args.userId,
      sourceThreadId: args.sourceThreadId,
    });

    return {
      kind: "read",
      userAlreadyReplied: closure.userHasReplied,
      documentRepliedAfter: userRepliedAfterMessage(
        closure.lastUserReplyAt,
        args.document.authoredAt,
      ),
    };
  } catch (error) {
    return { kind: "read_failed", error };
  }
}
