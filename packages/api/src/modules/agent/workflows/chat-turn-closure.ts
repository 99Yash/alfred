import {
  HttpError,
  runStatusSchema,
  sanitizeToolResult,
  toMessage,
  type ChatErrorKind,
  type ChatMessageUsage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  agentRuns,
  apiCallLog,
  chatAttachments,
  chatMessages,
  chatThreads,
} from "@alfred/db/schemas";
import { and, eq, like, or, sql } from "drizzle-orm";
import { publishEvent } from "../../../events/publish";
import { emitReplicachePokes } from "../../../events/replicache-events";
import { logger } from "../../../lib/logger";
import { finalizeRunArtifacts } from "../../artifacts/write";
import { scheduleThreadIdleExtraction } from "../../chat-memory/queue";
import { scheduleConversationCompactionIfNeeded } from "../compaction";
import { foldModelUsage } from "../usage-fold";
import { sanitizeVoice } from "../voice-sanitize";
import type { ChatRunState } from "./chat-turn-state";
import { maybeGenerateThreadTitle } from "./chat-thread-title";
import { isStreamTimeoutAbort } from "./stream-timeout";

/**
 * How a chat turn ended, and the only input the closure protocol branches on.
 *
 * Every terminal chat turn runs the same seven-step sequence — upsert the
 * assistant row, bump the thread, close the run's artifacts, publish
 * `chat.message completed`, poke Replicache, then optionally arm the followup
 * work. The three ways a turn can end differ only in the policy this
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
  // A run already cancelled has its own closure coming (or already landed);
  // don't let a success/failure path overwrite it. The cancel path itself is
  // that closure, so it never checks.
  if (outcome.kind !== "cancelled" && (await runWasCancelled(runId))) return;

  const now = new Date();
  // ADR-0070 §1.3: a tool that streamed poison into any chat-message field
  // (content / reasoning / tool-call previews / narration) would re-throw on the
  // jsonb/text insert and wedge closure before `chat.message completed` fires.
  // Strip every field via the shared sanitizer, on every path.
  const fields = sanitizeChatMessageFields(state);
  const reasoningMs = state.reasoningMs > 0 ? state.reasoningMs : null;

  const written =
    outcome.kind === "failed"
      ? await insertFailedRow(userId, runId, state, fields, reasoningMs, outcome.error)
      : await upsertCompletedRow(userId, runId, state, fields, reasoningMs, now);
  // Nothing changed: either the row already exists (failed path, insert-only) or
  // it exists and is not a previous failed attempt (completed path's guarded
  // upsert). Someone else owns this message's ending.
  if (written.length === 0) return;

  await db()
    .update(chatThreads)
    .set({ lastMessageAt: now, rowVersion: sql`${chatThreads.rowVersion} + 1` })
    .where(and(eq(chatThreads.id, state.threadId), eq(chatThreads.userId, userId)));

  // Close out any artifacts this turn authored so the sidebar leaves the
  // placeholder state (ADR-0075). Tied to the run lifecycle so the boss never has
  // to call a separate "finish" tool.
  //  - completed: flip still-`generating` rows to `complete`.
  //  - cancelled: also reclaim `error` rows — whatever the turn had drafted stays
  //    readable rather than showing as broken for a stop the user chose.
  //  - failed: mark in-flight rows `error` rather than leaving them stuck
  //    `generating`. Partial content stays visible.
  await finalizeRunArtifacts(
    userId,
    runId,
    state.messageId,
    outcome.kind === "failed" ? "error" : "complete",
    outcome.kind === "cancelled" ? ["generating", "error"] : ["generating"],
  );

  await publishEvent({
    userId,
    kind: "chat.message",
    payload: { runId, threadId: state.threadId, messageId: state.messageId, phase: "completed" },
  });
  emitReplicachePokes([userId]);

  if (outcome.kind !== "completed") return;
  // Re-checked after the write: a cancel can land between the pre-check and
  // here, and the followups below all assume a live conversation.
  if (await runWasCancelled(runId)) return;
  armTurnFollowups(userId, runId, state);
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
  // ADR-0072 presence gate. An image-reject classifies `attachment` only when
  // the current turn carries an image (the "Send without it" retry can drop
  // it); when only an *earlier* turn's replayed image can be the culprit it
  // classifies `attachment_history` (retry can't reach it — new chat only);
  // with no image anywhere in the thread it's structurally impossible and falls
  // through to `generic`.
  const images = await threadImageAttachments(userId, state.threadId, state.userMessageId);
  const errorKind = classifyChatFailure(error, {
    currentTurnHasImage: images.currentTurn,
    historicalHasImage: images.historical,
  });
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
 * Roll up the turn's token usage + cost from its `api_call_log` rows for the
 * dev usage readout. Keyed on the boss `runId` — sub-agent child runs are
 * separate runs billed under their own ids and are not folded in (see
 * `.lessons/model-cost-recompute-from-tokens.md`). Best-effort: metering rows
 * are written fire-and-forget, so a straggler write can undercount the final
 * call; returns null when the run logged nothing.
 */
async function aggregateRunUsage(runId: string): Promise<ChatMessageUsage | null> {
  // Grouped by model so the readout can name every model that served the turn
  // (and catch a silent Anthropic→Gemini fallback); the turn totals are summed
  // back across the groups in JS.
  const rows = await db()
    .select({
      model: sql<string>`coalesce(${apiCallLog.model}, 'unknown')`,
      inputTokens: sql<string>`coalesce(sum(${apiCallLog.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${apiCallLog.outputTokens}), 0)`,
      cachedInputTokens: sql<string>`coalesce(sum(${apiCallLog.cachedInputTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${apiCallLog.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
    })
    .from(apiCallLog)
    .where(eq(apiCallLog.runId, runId))
    .groupBy(apiCallLog.model);
  if (rows.length === 0) return null;
  const usage = foldModelUsage(rows);
  return usage.calls === 0 ? null : usage;
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
  const visibleToolCalls = state.toolCallsLog.filter((toolCall) => !toolCall.nonExecution);
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

/**
 * Where image attachments live in a thread's replayed transcript, split by the
 * recovery the UI can offer (ADR-0072). The whole thread is replayed every turn
 * (.lessons/chat-vision-transcript-replay-poison.md), so a provider image-reject
 * can be caused by the current turn's image (droppable via "Send without it")
 * OR by an earlier turn's image (the retry can't reach it — only a new chat
 * can). Returns both so {@link classifyChatFailure} picks the honest kind.
 *
 * An "image attachment" is a `ready` direct image upload or a degraded modality
 * that contributed keyframe images. Joins through `chat_messages` because
 * `chat_attachments` is keyed by message, not thread.
 */
async function threadImageAttachments(
  userId: string,
  threadId: string,
  currentUserMessageId: string | undefined,
): Promise<{ currentTurn: boolean; historical: boolean }> {
  const rows = await db()
    .select({ messageId: chatAttachments.messageId })
    .from(chatAttachments)
    .innerJoin(chatMessages, eq(chatAttachments.messageId, chatMessages.id))
    .where(
      and(
        eq(chatMessages.userId, userId),
        eq(chatMessages.threadId, threadId),
        eq(chatAttachments.status, "ready"),
        or(
          like(chatAttachments.mime, "image/%"),
          sql`jsonb_array_length(${chatAttachments.degradedImageKeys}) > 0`,
        ),
      ),
    );
  let currentTurn = false;
  let historical = false;
  for (const r of rows) {
    if (currentUserMessageId && r.messageId === currentUserMessageId) currentTurn = true;
    else historical = true;
  }
  return { currentTurn, historical };
}

/**
 * Map a terminal chat-turn fault to a user-meaningful {@link ChatErrorKind}.
 * Branches on structured signals first ({@link HttpError.status}, our own
 * sentinel throws), then falls back to sniffing the message — providers don't
 * give us typed errors, so the string is the last resort. Order matters:
 * attachment rejections often *also* carry a 4xx, so check them before status.
 * Anything unrecognized is `generic` (the client shows a neutral retry). The
 * raw text never reaches the user — only this tag does.
 */
export function classifyChatFailure(
  err: unknown,
  opts: { currentTurnHasImage: boolean; historicalHasImage: boolean },
): ChatErrorKind {
  const msg = toMessage(err).toLowerCase();

  // ADR-0072: the only genuine attachment failure is the model provider
  // rejecting a hydrated image at the generation call (recurs on transcript
  // replay — see .lessons/chat-vision-transcript-replay-poison.md). The narrow
  // signal set replaces the old over-broad substring net (attachment|file|
  // image|media|mime) that mis-bucketed unrelated tool/export failures.
  //
  // "unsupported file" / "unsupported media" / "decode" / "corrupt" are NOT
  // image-specific on their own — a `drive.export_file: unsupported file export
  // type` (or any tool error) trips them in an image-bearing thread. Gate them
  // behind an explicit image/picture/photo mention so only a message that
  // actually names an image counts; everything else falls through to generic.
  const mentionsImage = msg.includes("image") || msg.includes("picture") || msg.includes("photo");
  const isImageReject =
    msg.includes("unable to process input image") ||
    msg.includes("invalid image") ||
    msg.includes("unsupported image") ||
    (mentionsImage &&
      (msg.includes("unsupported file") ||
        msg.includes("unsupported media") ||
        msg.includes("decode") ||
        msg.includes("corrupt")));
  if (isImageReject) {
    // Prefer the recoverable kind: if the current turn has an image, "Send
    // without it" can drop it. Otherwise, if only an earlier turn's replayed
    // image can be the culprit, say so honestly — the retry can't reach it.
    if (opts.currentTurnHasImage) return "attachment";
    if (opts.historicalHasImage) return "attachment_history";
    // No image anywhere → not an attachment failure; fall through to generic.
  }

  // Our own turn-cap sentinel (see `CHAT_TURN_CAP_MAX`) — the turn can't continue.
  if (msg.includes("chat_turn_limit_exceeded")) return "too_long";
  // Context / token ceilings reported by the provider.
  if (
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("prompt is too long")
  ) {
    return "too_long";
  }

  // Upstream throttling. Prefer the typed status; the substring match is a
  // fallback for stringified errors — `\b` so a request id / token count that
  // merely contains "429" doesn't get mis-tagged.
  if (err instanceof HttpError && err.status === 429) return "rate_limited";
  if (msg.includes("rate limit") || msg.includes("too many requests") || /\b429\b/.test(msg)) {
    return "rate_limited";
  }

  // Our own streaming circuit-breaker aborted the turn (it ran past the total
  // or chunk stream ceiling): the model ran long, not a provider fault, so tag
  // it `timeout` — the client can say "that took too long" and offer a plain
  // retry, distinct from the `overloaded` glitch copy. Checked *before* the
  // transient-fault net below, whose bare `timeout`/`timed out` substrings
  // would otherwise swallow it. The structural check catches the raw
  // `TimeoutError` DOMException; the message patterns are the stringified
  // fallback and stay narrow so a provider "gateway timeout" still reads as a
  // transient fault below.
  if (
    isStreamTimeoutAbort(err) ||
    msg.includes("aborted due to timeout") ||
    msg.includes("operation timed out") ||
    msg.includes("timeout of ")
  ) {
    return "timeout";
  }

  // Transient provider faults — 5xx, "internal error", overloaded, network.
  if (err instanceof HttpError && err.status >= 500) return "overloaded";
  if (
    msg.includes("internal error") ||
    msg.includes("overloaded") ||
    msg.includes("unavailable") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    /\b50[23]\b/.test(msg)
  ) {
    return "overloaded";
  }

  return "generic";
}
