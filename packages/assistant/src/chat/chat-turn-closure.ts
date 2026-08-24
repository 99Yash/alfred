import { runStatusSchema, sanitizeToolResult } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, chatMessages, chatThreads, type ChatMessageStatus } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { publishEvent } from "@alfred/assistant/triggers";
import { emitReplicachePokes } from "@alfred/assistant/triggers";
import { logger } from "@alfred/logging";
import { finalizeRunArtifacts } from "@alfred/assistant/artifacts";
import { scheduleThreadIdleExtraction } from "./idle-capture-queue";
import { aggregateRunUsage } from "@alfred/assistant/execution";
import { sanitizeVoice } from "@alfred/ai/voice";
import { scheduleConversationCompactionIfNeeded } from "./compaction";
import { classifyChatTurnFailure } from "./chat-failure-kind";
import type { ChatRunState } from "./chat-turn-state";
import { maybeGenerateThreadTitle } from "./chat-thread-title";

/**
 * The closure protocol: how a terminal chat turn is persisted and handed to the
 * client. One sequence, one policy table, three named doors into it.
 *
 * Scoped to that and nothing else. What a fault is *called* is
 * `./chat-failure-kind`, what a run's spend adds up to is `../usage-fold`, and
 * what images a thread carries is `./chat-attachments` — none of those change
 * when a turn ending is added or the write sequence moves, and adding a
 * {@link ChatTurnOutcome} does not change any of them.
 */

/**
 * How a chat turn ended, and the only input the closure protocol branches on.
 *
 * Every terminal chat turn runs the same seven-step sequence — upsert the
 * assistant row, bump the thread, close the run's artifacts, publish
 * `chat.message completed`, poke Replicache, then optionally arm the followup
 * work. The ways a turn can end differ only in the {@link ClosurePolicy} this
 * discriminant selects; before {@link closeChatTurn} they were two hand-written
 * copies of that sequence, and keeping them in step was a review problem.
 */
type ChatTurnOutcome =
  /** A healthy turn the thread is expected to keep building on. */
  | { kind: "completed" }
  /** A turn the user (or the approvals `cancel_run` decision) deliberately ended. */
  | { kind: "cancelled" }
  /** A terminal fault: stream error, turn-cap, a down provider. */
  | { kind: "failed"; error: unknown };

/**
 * Everything the closure sequence decides per ending, in one table rather than
 * one inline test per decision point.
 *
 * These decisions co-vary by definition — together they *are* what "this kind of
 * ending" means — so a new {@link ChatTurnOutcome} has to answer all of them. As
 * inline `outcome.kind === …` tests spread down {@link closeChatTurn} it answered
 * none: a fourth ending compiled clean and silently inherited the completed
 * policy (guarded upsert with usage attached, artifacts flipped to `complete`,
 * `chat.message completed` published), which is the one shape a new ending must
 * never get for free. As a `satisfies Record<kind, …>` a missing row stops the
 * build.
 *
 * Which *row* the ending writes is not in here: it is the one decision that
 * needs the ending's payload rather than just its kind (a `failed` close carries
 * the fault to classify), so it stays an exhaustive `switch` in
 * {@link closeChatTurn} — which a new kind also has to answer before it
 * compiles. One gate each, no decision stated twice.
 */
interface ClosurePolicy {
  /**
   * Whether an already-`cancelled` run means "someone else owns this ending, do
   * nothing". The cancel path itself *is* that closure, so it never yields; a
   * success or failure path must, or it overwrites the cancel's row.
   */
  readonly yieldToCancel: boolean;
  /**
   * How this ending closes the artifacts the turn authored (ADR-0075) — the
   * terminal status, and which in-flight statuses it may claim. `failed` marks
   * them `error` rather than leaving them stuck `generating`, with partial
   * content still visible; `cancelled` closes them `complete` *and* reclaims
   * `error` rows, so a stop the user chose leaves the draft readable rather than
   * showing as broken.
   */
  readonly artifacts: {
    readonly to: "complete" | "error";
    readonly from: readonly ("generating" | "error")[];
  };
  /**
   * Whether to arm {@link armTurnFollowups}. All three schedulers assume a live
   * conversation and one of them spends a cheap-model call, so only an ending
   * the thread is expected to keep building on gets them.
   */
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
 * Persist a terminal chat turn and close the loop for the client.
 *
 * The durable row is what survives reload and reaches every device; the streamed
 * deltas were ephemeral. Idempotent on `messageId` so a re-attempt after the
 * executor commits doesn't double-write.
 *
 * Not exported. Which ending a turn gets is a decision, so callers go through
 * the three named finalizers below and have to name theirs rather than inherit
 * one — see {@link finalizeAssistantMessage} for what that buys.
 */
async function closeChatTurn(
  userId: string,
  runId: string,
  state: ChatRunState,
  outcome: ChatTurnOutcome,
): Promise<void> {
  const policy = CLOSURE_POLICY[outcome.kind];
  // A run already cancelled has its own closure coming (or already landed);
  // don't let a success/failure path overwrite it. The cancel path itself is
  // that closure, so it never yields.
  if (policy.yieldToCancel && (await runWasCancelled(runId))) return;

  const now = new Date();
  // ADR-0070 §1.3: a tool that streamed poison into any chat-message field
  // (content / reasoning / tool-call previews / narration) would re-throw on the
  // jsonb/text insert and wedge closure before `chat.message completed` fires.
  // Strip every field via the shared sanitizer, on every path.
  const fields = sanitizeChatMessageFields(state);
  const reasoningMs = state.reasoningMs > 0 ? state.reasoningMs : null;

  // The row is the one per-ending decision that reads the ending's payload, not
  // just its kind, so it is a switch rather than a {@link CLOSURE_POLICY} field.
  // Exhaustive on purpose: a new ending leaves `written` unassigned and the build
  // fails here, which is the right place to decide whether it may replace a
  // failed attempt and whether it carries usage.
  let written: { id: string }[];
  switch (outcome.kind) {
    case "failed":
      written = await insertFailedRow(userId, runId, state, fields, reasoningMs, outcome.error);
      break;
    case "completed":
    case "cancelled":
      written = await upsertCompletedRow(userId, runId, state, fields, reasoningMs, now);
      break;
  }
  // Nothing changed: a prior attempt of this run already wrote a terminal row for
  // THIS `messageId`. The client's replay-recovery barrier releases only on the
  // `chat.message completed` frame, and that first attempt may have died before
  // publishing it (e.g. `finalizeRunArtifacts` faulted), so republish it here.
  //
  // This is ending-INDEPENDENT, which is why it is not a `ClosurePolicy` field: a
  // `completed` close that faults after writing its `complete` row is caught in
  // `chatTurnStep` and re-routed through `finalizeFailedMessage`, so the retry
  // that finds the terminal row arrives as a `failed` close. Gating the republish
  // on the ending would relocate the leak to that branch. The frame carries only
  // `phase:"completed"` (no status, no error), and a terminal `chat.message` is
  // absorbing client-side, so republishing it never demotes a completed reply and
  // is harmlessly redundant when the first attempt already sent it.
  //
  // Re-close the run's artifacts here too, but NOT the thread bump or the
  // followups. `finalizeRunArtifacts` is ONE atomic UPDATE filtered on
  // `status IN (generating)`, so re-running it is idempotent — a no-op on any
  // artifact the first attempt already flipped out of `generating`, and it can
  // never leave a partial write. The first attempt may have faulted at or before
  // it (a `completed` close that throws inside `finalizeRunArtifacts` re-enters
  // here as a `failed` close), so an artifact it authored can still be stuck
  // `generating`; without this it strands there forever, since no reaper sweeps
  // `artifacts.status`. The thread bump (a row-version increment) and the
  // followups (which arm timers) are NOT idempotent — a double-arm is a real
  // bug — so they stay skipped, first-writer-wins.
  //
  // Derive the artifact terminal status from the PERSISTED `chat_messages` row,
  // not this retry's `outcome.kind`: the reachable case re-enters as a `failed`
  // close over an already-`complete` row, so keying off the retry's kind would
  // flip a completed turn's artifacts to `error`. When the row is gone (a
  // concurrent thread cascade-delete between the insert-conflict and this read),
  // skip the finalize — the artifacts cascade-delete with it.
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

  // Close out any artifacts this turn authored so the sidebar leaves the
  // placeholder state (ADR-0075). Tied to the run lifecycle so the boss never has
  // to call a separate "finish" tool; which status each ending closes them into
  // is `ClosurePolicy.artifacts`.
  await finalizeRunArtifacts(
    userId,
    runId,
    state.messageId,
    policy.artifacts.to,
    policy.artifacts.from,
  );

  await publishCompletedFrame(userId, runId, state);

  if (!policy.followups) return;
  // Re-checked after the write: a cancel can land between the pre-check and
  // here, and the followups below all assume a live conversation.
  if (await runWasCancelled(runId)) return;
  armTurnFollowups(userId, runId, state);
}

/**
 * Release the client for a terminal turn: publish the `chat.message completed`
 * frame AND poke Replicache. These two effects are one indivisible client-release,
 * not two adjacent statements a path can omit.
 *
 * The frame is the sole release for the client's replay-recovery barrier, which
 * is armed at `chat.message started`; it reconciles the live streaming bubble over
 * SSE. The poke tells the Replicache-backed views (the message list, the thread
 * row) to pull the durable row this turn just committed. Both are reached from two
 * places: the normal closure path, after the row and artifacts are written; and
 * the already-terminal zero-row branch above, where a prior attempt wrote the row
 * but may have died before either effect fired. A terminal `chat.message` is
 * absorbing client-side and the poke is idempotent, so republishing both over an
 * already-released turn is harmlessly redundant. Folding the poke in here is why
 * the zero-row republish can no longer release the barrier while leaving the
 * Replicache views un-poked.
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

/**
 * The completed-turn upsert. Guarded so the DO UPDATE can only ever replace a
 * `failed` row of this user's thread — a retry re-finalizing after a crash,
 * never a message that already completed.
 */
async function upsertCompletedRow(
  userId: string,
  runId: string,
  state: ChatRunState,
  fields: SanitizedChatMessageFields,
  reasoningMs: number | null,
  now: Date,
): Promise<{ id: string }[]> {
  const usage = await aggregateRunUsage(runId);
  // Drizzle types `and()` as `SQL | undefined` because it collapses when every
  // condition is undefined; all three here are unconditional, so it never does.
  // Checked rather than `!`-ed anyway: a collapsed `setWhere` is not a type error
  // at the call site, it is silently *no* guard, and the upsert would overwrite
  // whatever row already holds this id.
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
  return await db()
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
 * The failed-turn insert. `onConflictDoNothing`, not an upsert: a row that
 * already exists for this message is either a completed reply (which a late
 * fault must not demote to an error) or an earlier failure that already said the
 * same thing. No `usage` either — a faulted turn's spend is in `api_call_log`,
 * and the client's failed state reads only `errorKind`.
 */
async function insertFailedRow(
  userId: string,
  runId: string,
  state: ChatRunState,
  fields: SanitizedChatMessageFields,
  reasoningMs: number | null,
  error: unknown,
): Promise<{ id: string }[]> {
  // Never surface the raw provider error to the user: it leaks vendor URLs
  // (e.g. developers.generativeai.google) and "Failed after N attempts" noise.
  // Instead classify it into a user-meaningful `errorKind` the client maps to a
  // tailored message + recovery action; log the raw detail server-side for
  // diagnosis. Content stays empty (or whatever streamed before the fault) —
  // the failed-state copy is owned client-side, keyed off `errorKind`.
  const errorKind = await classifyChatTurnFailure(userId, state, error);
  logger.warn(
    { err: error, event: "chat_turn_failed", runId, threadId: state.threadId, errorKind },
    "Chat turn failed",
  );
  return await db()
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
      runId,
    })
    .onConflictDoNothing()
    .returning({ id: chatMessages.id });
}

/**
 * The background work a healthy turn arms on top of its row: end-of-thread
 * memory capture (chat-mem v1, #398, D9), background transcript compaction, and
 * a generated thread title. All three are fire-and-forget — none of them may
 * delay or fail the reply that just landed.
 */
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

/**
 * Persist a finished assistant turn and arm the background work that follows a
 * turn the thread is expected to keep building on.
 *
 * The three schedulers in {@link armTurnFollowups} all assume a live
 * conversation: memory capture reads the settled thread, compaction bounds a
 * transcript that will be sent again, and titling spends a cheap-model call on
 * the opening exchange. A turn the user *ended* is not that, so it goes through
 * {@link finalizeCancelledMessage}; a failed turn goes through
 * {@link finalizeFailedMessage}. Which ending a terminal turn gets is a
 * decision, so each caller has to name its finalizer rather than inherit this
 * one.
 */
export async function finalizeAssistantMessage(
  userId: string,
  runId: string,
  state: ChatRunState,
): Promise<void> {
  await closeChatTurn(userId, runId, state, { kind: "completed" });
}

/**
 * End a turn the user cancelled: persist the row, close the artifacts, emit
 * `chat.message completed`, and stop.
 *
 * Row status stays `complete`, not `failed` — a deliberate stop is not an error
 * and must not render a retry affordance for an action the user took on purpose.
 * In-flight artifacts likewise close `complete` rather than `error`, so whatever
 * the turn had drafted stays readable instead of showing as broken.
 *
 * What it deliberately does NOT do is arm the followups. Memory capture,
 * compaction and titling all read as "the thread is still going"; the last of
 * them spends a cheap-model call. Cancelling is the user saying it is not still
 * going, and the only cancel caller today is the approvals `cancel_run`, which
 * fires on a run parked at an approval — so the row it closes often carries no
 * new text at all, and titling it would be spend on nothing. If the thread does
 * continue, the next real turn arms all three anyway; each is a debounce or a
 * first-write-wins, not a one-shot.
 */
export async function finalizeCancelledMessage(
  userId: string,
  runId: string,
  state: ChatRunState,
): Promise<void> {
  await closeChatTurn(userId, runId, state, { kind: "cancelled" });
}

/**
 * Terminal-failure counterpart to {@link finalizeAssistantMessage}. Persists a
 * `status:"failed"` assistant row (carrying whatever text streamed before the
 * fault) and emits `chat.message completed` so the client's streaming bubble
 * reconciles to the durable row instead of blinking indefinitely. Idempotent on
 * messageId; the partial-failure `error` is surfaced via the failed status.
 */
export async function finalizeFailedMessage(
  userId: string,
  runId: string,
  state: ChatRunState,
  err: unknown,
): Promise<void> {
  await closeChatTurn(userId, runId, state, { kind: "failed", error: err });
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

/**
 * The persisted terminal status of an assistant message, or `undefined` when no
 * row exists. The zero-row closure branch reads this to close the run's
 * artifacts into the same terminal status the durable row carries — a
 * `completed` close that faults re-enters as a `failed` close, so the retry's
 * `outcome.kind` is the wrong source. The `status` column is `$type`-tagged
 * {@link ChatMessageStatus}, so the read is already typed.
 */
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
 * The persisted text fields of an assistant chat message, scrubbed of
 * persistence-poison (ADR-0070 §1.3). Every ending routes the text/jsonb fields
 * it writes through here, so a NUL byte or lone surrogate that streamed into
 * `content`, `reasoning`, the tool-call previews, *or* `narration` can never
 * re-throw on the insert and wedge the turn. One `sanitizeToolResult` pass
 * covers nested structures and object keys.
 *
 * `content` and each `narration` segment are Alfred's own final prose, so they
 * also run through {@link sanitizeVoice} — the deterministic half of
 * `DEFAULT_VOICE_PROMPT` (the chat boss is told "No em-dashes" but a prompt is
 * not a guarantee; this is the same mechanical enforcement briefing already
 * applies in `compose.ts`). It preserves code, quotations, links, and
 * identifiers, so exact-copy material inside those stays verbatim. `reasoning`
 * (internal chain-of-thought) and the tool previews (raw tool data, not Alfred
 * prose) are left untouched. This matches the live stream, which coalesces
 * deltas through a `createVoiceStreamSanitizer`; both share the same lexical
 * transform, so the reconciled bubble is identical to what streamed.
 */
export function sanitizeChatMessageFields(state: ChatRunState): SanitizedChatMessageFields {
  // Non-execution bounces are internal plumbing the client retracts — except
  // a connection-health bounce (#378 item 3), which carries the user-meaningful
  // repair and is kept precisely so a reload can re-offer it.
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
  return sanitizeToolResult(raw).value as typeof raw;
}
