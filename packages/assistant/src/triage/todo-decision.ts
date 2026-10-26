import type { UserSettings } from "@alfred/assistant/settings";
import type {
  ReportedSenderSuppressions,
  SenderSuppressionMatch,
  SenderSuppressionOutcome,
} from "../knowledge";
import {
  resolveTodoSuggestion,
  todoSuppressionReason,
  type AssistDateAnchor,
  type ResolvedTodoSuggestion,
  type TodoSuppressionReason,
  type TriageClassification,
} from "./classify";
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
  | { kind: "standing_instruction"; match: SenderSuppressionMatch }
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

export type TriageTodoDecision = {
  outcome: TriageTodoOutcome;
  /** The `block_todo_suggestion` read, for the decision trace. `none` when no todo is proposed. */
  standingSuppression: SenderSuppressionOutcome;
  closure: TriageThreadClosureRead;
};

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
  senderAddress: string | null;
  isColdContact: boolean;
  actionItemsEnabled: boolean;
  /** The step's one `"report"` load, so the todo lane and the category lane agree. */
  suppressions: ReportedSenderSuppressions;
}): Promise<TriageTodoDecision> {
  const { document, classification } = args;

  // Read the zone only when a todo is proposed. The step bind usually holds it already.
  const assistDateAnchor: AssistDateAnchor | null =
    document.authoredAt && classification.todoSuggestion
      ? { sentAt: document.authoredAt, timezone: await args.settings.timezone() }
      : null;

  const todo = resolveTodoSuggestion(classification, assistDateAnchor);
  const closure = args.reason === "reply" ? await readClosure(args) : { kind: "not_read" as const };

  if (!todo) return { outcome: { kind: "none" }, standingSuppression: { kind: "none" }, closure };

  const standingSuppression = args.suppressions.match(
    { sender: args.senderAddress ?? document.metadata.from ?? null, accountId: document.accountId },
    "block_todo_suggestion",
  );

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
    standingSuppression.kind === "suppressed"
      ? { kind: "standing_instruction", match: standingSuppression.match }
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
