import {
  applyChatDelta,
  createChatDeltaLog,
  runStatusSchema,
  sanitizeToolResult,
  type ChatErrorKind,
  type ChatMessageUsage,
} from "@alfred/contracts";
import { eventPayloadSchemas } from "@alfred/contracts/events";
import { db } from "@alfred/db";
import {
  agentRuns,
  chatMessages,
  chatThreads,
  eventsOutbox,
  type ChatMessageStatus,
} from "@alfred/db/schemas";
import { and, asc, eq, sql } from "drizzle-orm";
import { publishEvent } from "@alfred/assistant/triggers";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { logger } from "@alfred/logging";
import { finalizeRunArtifacts } from "@alfred/assistant/artifacts";
import { scheduleThreadIdleExtraction } from "./idle-capture-queue";
import {
  aggregateRunUsage,
  withStepLease,
  type AgentDbExecutor,
  type StepLease,
} from "@alfred/assistant/execution";
import { routeEffort } from "@alfred/ai";
import { sanitizeVoice } from "@alfred/ai/voice";
import { scheduleConversationCompactionIfNeeded } from "./compaction";
import { classifyChatTurnFailure } from "./chat-failure-kind";
import { closeNarrationSegment, type ChatRunState } from "./chat-turn-state";
import { maybeGenerateThreadTitle } from "./chat-thread-title";

/**
 * Persist a terminal chat turn and release the client.
 * One sequence, one policy table, three named finalizers.
 */

/** How a chat turn ended. The closure branches only on this. */
type ChatTurnOutcome =
  | { kind: "completed" }
  /** The user ended the turn on purpose. */
  | { kind: "cancelled" }
  /** A terminal fault: stream error, turn-cap, a down provider. */
  | { kind: "failed"; error: unknown };

/**
 * Each ending's decisions in one table, so a new ending must answer all of them.
 * The row write needs the payload, so it is a `switch` in {@link closeChatTurn}.
 */
interface ClosurePolicy {
  /** Do nothing if the run is already cancelled, so the cancel's row survives. */
  readonly yieldToCancel: boolean;
  /**
   * How the turn's artifacts close (ADR-0075). A cancel also reclaims `error`
   * rows, so a draft the user stopped stays readable.
   */
  readonly artifacts: {
    readonly to: "complete" | "error";
    readonly from: readonly ("generating" | "error")[];
  };
  /** Arm {@link armTurnFollowups}. They assume a live conversation, and titling costs a model call. */
  readonly followups: boolean;
}

const CLOSURE_POLICY = {
  completed: {
    yieldToCancel: true,
    artifacts: { to: "complete", from: ["generating"] },
    followups: true,
  },
  cancelled: {
    yieldToCancel: false,
    artifacts: { to: "complete", from: ["generating", "error"] },
    followups: false,
  },
  failed: {
    yieldToCancel: true,
    artifacts: { to: "error", from: ["generating"] },
    followups: false,
  },
} as const satisfies Record<ChatTurnOutcome["kind"], ClosurePolicy>;

/**
 * Who writes the row. A step body passes its lease, so a body whose lease was reclaimed
 * writes nothing. `null` only for the executor's `onTerminal` hook, which runs after the
 * last lease ends.
 */
type CloseWriter = StepLease | null;

/** Idempotent on `messageId`. Callers use the named finalizers below. */
async function closeChatTurn(
  userId: string,
  runId: string,
  state: ChatRunState,
  outcome: ChatTurnOutcome,
  writer: CloseWriter,
): Promise<void> {
  const policy = CLOSURE_POLICY[outcome.kind];

  if (policy.yieldToCancel && (await runWasCancelled(runId))) return;

  const now = new Date();
  const fields = sanitizeChatMessageFields(state);
  const reasoningMs = state.reasoningMs > 0 ? state.reasoningMs : null;
  // Slow reads stay outside the fence, so the run row lock is held only for the write.
  const usage = await aggregateRunUsage(runId, routeEffort(state.tier));

  // Exhaustive: a new ending leaves `write` unassigned and fails the build.
  let write: (tx: AgentDbExecutor) => Promise<{ id: string }[]>;

  switch (outcome.kind) {
    case "failed": {
      // The raw error leaks vendor URLs, so store only `errorKind`. The client owns the copy.
      const errorKind = await classifyChatTurnFailure(userId, state, outcome.error);
      logger.warn(
        {
          err: outcome.error,
          event: "chat_turn_failed",
          runId,
          threadId: state.threadId,
          errorKind,
        },
        "Chat turn failed",
      );
      write = (tx) =>
        insertFailedRow(tx, userId, runId, state, { fields, reasoningMs, usage, errorKind });
      break;
    }

    case "completed":
    case "cancelled":
      write = (tx) =>
        upsertCompletedRow(tx, userId, runId, state, { fields, reasoningMs, usage, now });
      break;
  }

  let written: { id: string }[];

  if (writer === null) {
    written = await write(db());
  } else {
    const fenced = await withStepLease(writer, write);

    // The live attempt owns the row and the client release, so do not republish here.
    if (!fenced.ok) {
      logger.warn(
        {
          event: "chat_turn_close_superseded",
          runId,
          attempt: writer.attempt,
          cause: fenced.cause,
          outcome: outcome.kind,
        },
        "Skipped the chat row write: this attempt no longer owns the run",
      );

      return;
    }

    written = fenced.value;
  }

  // A prior attempt already wrote the row but may have died before releasing the
  // client. Republish and re-close artifacts (both idempotent); no reaper fixes a
  // stuck `generating` artifact. Skip the thread bump and followups: not idempotent.
  // Take the status from the stored row: a faulted `completed` close retries as `failed`.
  if (written.length === 0) {
    const status = await readMessageStatus(userId, state.messageId);

    if (status !== undefined) {
      await finalizeRunArtifacts(
        userId,
        runId,
        state.messageId,
        status === "complete" ? "complete" : "error",
        ["generating"],
      );
    }

    await publishCompletedFrame(userId, runId, state);

    return;
  }

  await db()
    .update(chatThreads)
    .set({ lastMessageAt: now, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(and(eq(chatThreads.id, state.threadId), eq(chatThreads.userId, userId)));

  // The run closes its artifacts, so the boss needs no "finish" tool (ADR-0075).
  await finalizeRunArtifacts(
    userId,
    runId,
    state.messageId,
    policy.artifacts.to,
    policy.artifacts.from,
  );

  await publishCompletedFrame(userId, runId, state);

  if (!policy.followups) return;

  // A cancel can land after the first check.
  if (await runWasCancelled(runId)) return;
  armTurnFollowups(userId, runId, state);
}

/**
 * Release the client: the `completed` frame ends the streaming bubble, and the poke
 * makes Replicache pull the row. Always both. Safe to repeat.
 */
async function publishCompletedFrame(
  userId: string,
  runId: string,
  state: ChatRunState,
): Promise<void> {
  await publishEvent({
    untransacted: true,
    userId,
    kind: "chat.message",
    payload: { runId, threadId: state.threadId, messageId: state.messageId, phase: "completed" },
  });
  emitReplicachePokes([userId]);
}

/** The row columns {@link closeChatTurn} computes before the fenced write. */
interface ChatRowFields {
  fields: SanitizedChatMessageFields;
  reasoningMs: number | null;
  usage: ChatMessageUsage | null;
}

/** Insert the completed row. On conflict it replaces only a `failed` row of this thread. */
async function upsertCompletedRow(
  tx: AgentDbExecutor,
  userId: string,
  runId: string,
  state: ChatRunState,
  { fields, reasoningMs, usage, now }: ChatRowFields & { now: Date },
): Promise<{ id: string }[]> {
  // `and()` can return undefined, and an undefined `setWhere` silently removes the guard.
  const onlyIfPreviousAttemptFailed = and(
    eq(chatMessages.status, "failed"),
    eq(chatMessages.userId, userId),
    eq(chatMessages.threadId, state.threadId),
  );

  if (!onlyIfPreviousAttemptFailed) {
    throw new Error(
      "closeChatTurn: failed-row guard collapsed to undefined — refusing an unguarded upsert",
    );
  }

  return await tx
    .insert(chatMessages)
    .values({
      id: state.messageId,
      userId,
      threadId: state.threadId,
      role: "assistant",
      content: fields.content,
      reasoning: fields.reasoning,
      reasoningMs,
      status: "complete",
      toolCalls: fields.toolCalls,
      narration: fields.narration,
      usage,
      runId,
    })
    .onConflictDoUpdate({
      target: chatMessages.id,
      set: {
        content: fields.content,
        reasoning: fields.reasoning,
        reasoningMs,
        status: "complete",
        errorKind: null,
        toolCalls: fields.toolCalls,
        narration: fields.narration,
        usage,
        runId,
        rowVersion: sql`${chatMessages.rowVersion} + 1`,
        updatedAt: now,
      },
      setWhere: onlyIfPreviousAttemptFailed,
    })
    .returning({ id: chatMessages.id });
}

/**
 * Insert the failed row. Do nothing on conflict: a late fault must not demote a
 * completed reply. It carries `usage` too, because a failed turn can be the most expensive one.
 */
async function insertFailedRow(
  tx: AgentDbExecutor,
  userId: string,
  runId: string,
  state: ChatRunState,
  { fields, reasoningMs, usage, errorKind }: ChatRowFields & { errorKind: ChatErrorKind },
): Promise<{ id: string }[]> {
  return await tx
    .insert(chatMessages)
    .values({
      id: state.messageId,
      userId,
      threadId: state.threadId,
      role: "assistant",
      content: fields.content,
      reasoning: fields.reasoning,
      reasoningMs,
      status: "failed",
      errorKind,
      toolCalls: fields.toolCalls,
      narration: fields.narration,
      usage,
      runId,
    })
    .onConflictDoNothing()
    .returning({ id: chatMessages.id });
}

/** Memory capture, compaction, and titling. Fire-and-forget: none may delay or fail the reply. */
function armTurnFollowups(userId: string, runId: string, state: ChatRunState): void {
  void scheduleThreadIdleExtraction({
    userId,
    threadId: state.threadId,
    captureAfterMessageId: state.messageId,
  });
  void scheduleConversationCompactionIfNeeded({
    userId,
    threadId: state.threadId,
    latestUserMessageId: state.userMessageId,
    tier: state.tier,
  }).catch((error) => {
    logger.warn(
      { err: error, event: "chat_compaction_schedule_failed", threadId: state.threadId },
      "Chat background compaction scheduling failed",
    );
  });
  void maybeGenerateThreadTitle({
    userId,
    runId,
    threadId: state.threadId,
    assistantMessageId: state.messageId,
    assistantText: state.assistantText,
  });
}

/** Persist a finished turn and arm its followups. Only while `lease` still owns the run. */
export async function finalizeAssistantMessage(
  userId: string,
  state: ChatRunState,
  lease: StepLease,
): Promise<void> {
  await closeChatTurn(userId, lease.runId, state, { kind: "completed" }, lease);
}

/**
 * Persist a cancelled turn as `complete`, not `failed`: a deliberate stop is no error.
 * No followups. The next real turn arms them anyway.
 */
export async function finalizeCancelledMessage(
  userId: string,
  runId: string,
  state: ChatRunState,
): Promise<void> {
  await closeChatTurn(userId, runId, state, { kind: "cancelled" }, null);
}

/**
 * Persist a `failed` row with whatever streamed, and release the client.
 * A step body passes its lease; only the executor's `onTerminal` hook passes `null`.
 */
export async function finalizeFailedMessage(
  userId: string,
  runId: string,
  state: ChatRunState,
  err: unknown,
  lease: StepLease | null,
): Promise<void> {
  await closeChatTurn(userId, runId, state, { kind: "failed", error: err }, lease);
}

/**
 * Fold the `chat.delta` text the outbox holds after the last commit into `state`.
 * For the executor's failure closure only: its state is the pre-step snapshot, so the
 * faulted step's streamed text is not in it. The outbox is the only path to the client
 * (ADR-0005), so it holds what was streamed, also for an attempt whose process died.
 * Returns a copy when a row folds. Returns `state` itself when no row folds, and on
 * any fault, so the failed row still lands.
 */
export async function foldUncommittedDeltas(
  userId: string,
  state: ChatRunState,
): Promise<ChatRunState> {
  try {
    const rows = await db()
      .select({ id: eventsOutbox.id, payload: eventsOutbox.payload })
      .from(eventsOutbox)
      .where(
        and(
          eq(eventsOutbox.userId, userId),
          eq(eventsOutbox.kind, "chat.delta"),
          sql`${eventsOutbox.payload}->>'messageId' = ${state.messageId}`,
        ),
      )
      .orderBy(asc(eventsOutbox.id));

    // The bubble's own rule, in the same outbox `id` order, so a reclaimed attempt's text
    // replaces the older attempt's uncommitted text here as it does on screen.
    const log = createChatDeltaLog(state.deltaSeq);

    for (const row of rows) {
      const delta = eventPayloadSchemas["chat.delta"].safeParse(row.payload);

      if (!delta.success) {
        logger.warn(
          { event: "chat_delta_fold_unparsable", outboxId: row.id, messageId: state.messageId },
          "Skipped an unparsable chat.delta outbox row",
        );
        continue;
      }

      // Committed segments are already closed onto the narration trail.
      if (delta.data.segmentIndex < state.segmentIndex) continue;
      applyChatDelta(log, { ...delta.data, segment: delta.data.segmentIndex });
    }

    if (log.segments.size === 0) return state;

    // A shallow copy is enough: `closeNarrationSegment` replaces the array, it does not push.
    const folded: ChatRunState = { ...state, deltaSeq: log.seq };

    // `keepText` stays true even when `reissuePending` is set, unlike `closeLeadInNarration`:
    // the outbox proves the user saw this text.
    for (const [index, text] of [...log.segments].sort(([a], [b]) => a - b)) {
      while (folded.segmentIndex < index) {
        closeNarrationSegment(folded, { keepText: true, advanceWhenNothingKept: true });
      }

      folded.assistantText += text;
    }

    return folded;
  } catch (err) {
    logger.warn(
      { err, event: "chat_delta_fold_failed", messageId: state.messageId },
      "Could not fold streamed chat deltas into the failed row",
    );

    return state;
  }
}

async function runWasCancelled(runId: string): Promise<boolean> {
  const rows = await db()
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  const status = runStatusSchema.safeParse(rows[0]?.status);

  return status.success && status.data === "cancelled";
}

/** The stored status of an assistant message, or `undefined` when no row exists. */
async function readMessageStatus(
  userId: string,
  messageId: string,
): Promise<ChatMessageStatus | undefined> {
  const rows = await db()
    .select({ status: chatMessages.status })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, messageId), eq(chatMessages.userId, userId)))
    .limit(1);

  return rows[0]?.status;
}

interface SanitizedChatMessageFields {
  content: string;
  reasoning: string | null;
  toolCalls: ChatRunState["toolCallsLog"] | null;
  narration: ChatRunState["narration"] | null;
}

/**
 * Strip NUL bytes and lone surrogates, which would make the insert throw (ADR-0070 §1.3).
 * Alfred's own prose also gets {@link sanitizeVoice}, the same transform as the
 * live stream, so the saved bubble matches what streamed.
 */
export function sanitizeChatMessageFields(state: ChatRunState): SanitizedChatMessageFields {
  // Drop non-execution bounces, but keep connection repairs so a reload can offer them (#378).
  const visibleToolCalls = state.toolCallsLog.filter(
    (toolCall) => !toolCall.nonExecution || toolCall.connectNudge !== undefined,
  );

  const raw = {
    content: sanitizeVoice(state.assistantText),
    reasoning: state.reasoningText.length > 0 ? state.reasoningText : null,
    toolCalls: visibleToolCalls.length > 0 ? visibleToolCalls : null,
    narration:
      state.narration.length > 0
        ? state.narration.map((segment) => ({ ...segment, text: sanitizeVoice(segment.text) }))
        : null,
  };

  return sanitizeToolResult(raw).value;
}
