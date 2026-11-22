import type { TranscriptMessage } from "@alfred/ai";
import { sanitizeVoice } from "@alfred/ai/voice";
import {
  humanizeToolName,
  isActionTool,
  leavesEffectUnconfirmed,
  mcpBoundCallInput,
  SPAWN_SUB_AGENT_TOOL,
  withDefaults,
} from "@alfred/contracts";
import { publishEvent } from "@alfred/assistant/triggers";
import { isSelectedMcpToolReadOnly } from "@alfred/assistant/tool-runtime/mcp";
import { db } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import {
  appendChildResultNotes,
  joinSpawnedChildren,
  listSpawnedChildRuns,
  appendSystemNote,
  resetChatTurnRetryBudgets,
  scheduleSubAgentJoinWakeJob,
  type JoinSpawnedChildrenDeps,
  type StepContext,
  type StepResult,
} from "@alfred/assistant/execution";
import {
  closeNarrationSegment,
  interruptChatRun,
  type ChatRunState,
  type ToolCallLogEntry,
} from "./chat-turn-state";
import { judgeFailedWriteReport, type FailedWrite } from "./failed-write-report";

/**
 * The work between "the model answered" and "the turn may complete".
 * Each guard returns a `StepResult` to take over (park or regenerate), or `null`.
 */

/** Publish one `chat.delta` on the current segment, with the step's replay fence. */
async function publishSegmentDelta(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  publish: typeof publishEvent,
  text: string,
): Promise<void> {
  state.deltaSeq += 1;
  await publish({
    untransacted: true,
    userId: ctx.userId,
    kind: "chat.delta",
    payload: {
      runId: ctx.runId,
      threadId: state.threadId,
      messageId: state.messageId,
      seq: state.deltaSeq,
      attempt: ctx.attempt,
      fromSeq: ctx.state.deltaSeq,
      text,
      segmentIndex: state.segmentIndex,
    },
  });
}

/**
 * Move a rejected answer into narration, then publish an empty `chat.delta` on the new segment.
 * The client advances segments only on a higher-segment delta, so without it the
 * rejected text stays on screen as the live reply. Returns whether it closed.
 */
async function closePrematureAnswerSegment(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  publish: typeof publishEvent,
): Promise<boolean> {
  // Rejected prose already streamed, so keep it. With nothing closed there is no segment to advance to.
  const closed = closeNarrationSegment(state, {
    keepText: true,
    advanceWhenNothingKept: false,
  });

  if (!closed) return false;
  await publishSegmentDelta(ctx, state, publish, "");

  return true;
}

/** Injectable I/O for tests. `listChildren` and `scheduleWake` go to {@link joinSpawnedChildren}. */
export interface GuardSpawnedChildrenDeps extends JoinSpawnedChildrenDeps {
  publish: typeof publishEvent;
}

const defaultGuardSpawnedChildrenDeps: GuardSpawnedChildrenDeps = {
  listChildren: listSpawnedChildRuns,
  scheduleWake: scheduleSubAgentJoinWakeJob,
  publish: publishEvent,
};

/**
 * The parent never answers while a child it spawned still runs (ADR-0073). The model has no await
 * tool, so this guard is the join (ADR-0130 amendment (i)). Any spawn call of the run, also one
 * that failed after its insert, makes the guard read the durable child rows. A run with no spawn
 * call has no child, so it makes no read. Park on a running child; fold finished ones and
 * regenerate.
 */
export async function guardSpawnedChildren(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  transcript: TranscriptMessage[],
  deps: GuardSpawnedChildrenDeps = defaultGuardSpawnedChildrenDeps,
): Promise<StepResult<ChatRunState> | null> {
  if (!state.toolCallsLog.some((t) => t.toolName === SPAWN_SUB_AGENT_TOOL)) return null;

  const join = await joinSpawnedChildren(
    { parentRunId: ctx.runId, userId: ctx.userId, foldedChildRunIds: state.foldedChildRunIds },
    deps,
  );

  if (join.notes.length === 0 && join.park === null) return null;

  state.foldedChildRunIds = join.foldedChildRunIds;

  const closedPrematureAnswer = await closePrematureAnswerSegment(ctx, state, deps.publish);

  // Drop the rejected answer from the tail. A resumed park sends this transcript to
  // the model, and with extended thinking Anthropic 400s on a trailing assistant message.
  const baseTranscript =
    closedPrematureAnswer && transcript.at(-1)?.role === "assistant"
      ? transcript.slice(0, -1)
      : transcript;

  const nextTranscript = appendChildResultNotes(baseTranscript, join.notes);

  if (join.park) {
    return interruptChatRun(state, nextTranscript, join.park);
  }

  return { kind: "next", state, transcript: nextTranscript, nextStep: "chat-turn" };
}

export interface GuardUnreportedToolFailuresDeps {
  /** The failed calls that may have been writes. Judged per call, not per tool name. */
  selectWrites: (
    ctx: StepContext<ChatRunState>,
    calls: readonly ToolCallLogEntry[],
  ) => Promise<FailedWrite[]>;
  judgeReply: typeof judgeFailedWriteReport;
  publish: typeof publishEvent;
}

/**
 * `mcp.call` is one name for every remote tool, so its name says nothing. Judge the
 * selected remote tool at the revision the call named. A call with no staging row or
 * no parseable input stays a write: guessing "read" would hide a failure.
 * The action record also says if the target may hold the effect (`leavesEffectUnconfirmed`).
 */
async function selectWriteCalls(
  ctx: StepContext<ChatRunState>,
  calls: readonly ToolCallLogEntry[],
): Promise<FailedWrite[]> {
  const rows = await db()
    .select({
      toolCallId: actionStagings.toolCallId,
      input: actionStagings.proposedInput,
      decidedInput: actionStagings.decidedInput,
      executeResult: actionStagings.executeResult,
    })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.userId, ctx.userId),
        eq(actionStagings.runId, ctx.runId),
        inArray(
          actionStagings.toolCallId,
          calls.map((c) => c.toolCallId),
        ),
      ),
    );

  const writes: FailedWrite[] = [];

  for (const call of calls) {
    const row = rows.find((r) => r.toolCallId === call.toolCallId);

    const write: FailedWrite = leavesEffectUnconfirmed(row?.executeResult)
      ? { ...call, effectUnconfirmed: true }
      : call;

    // A `code_run` run refused this direct read, and dispatch verified it reads (ADR-0124).
    if (call.verifiedRead) continue;

    if (call.toolName !== "mcp.call") {
      if (isActionTool(call.toolName)) writes.push(write);
      continue;
    }

    // The broker reads the same pair, so this names the tool that ran.
    const parsed = mcpBoundCallInput.safeParse(row?.decidedInput ?? row?.input);

    // One read per failed `mcp.call`. A turn has few, and each row saved its bound revision.
    const isRead =
      parsed.success && (await isSelectedMcpToolReadOnly({ userId: ctx.userId, ...parsed.data }));

    if (!isRead) writes.push(write);
  }

  return writes;
}

const defaultGuardUnreportedToolFailuresDeps: GuardUnreportedToolFailuresDeps = {
  selectWrites: selectWriteCalls,
  judgeReply: judgeFailedWriteReport,
  publish: publishEvent,
};

/**
 * Code supplies the fact when the model gives no note: which actions did not happen, and which
 * may have happened with no confirmation. "Nothing changed" is only true for the first kind.
 */
function fallbackFailureNote(failed: readonly FailedWrite[]): string {
  const names = (calls: readonly FailedWrite[]) => [
    ...new Set(calls.map((call) => humanizeToolName(call.toolName))),
  ];

  const notDone = names(failed.filter((call) => !call.effectUnconfirmed));
  const unconfirmed = names(failed.filter((call) => call.effectUnconfirmed));

  return [
    notDone.length > 0 ? `I couldn't ${notDone.join(", or ")}. Nothing changed there.` : "",
    unconfirmed.length > 0
      ? `I couldn't confirm ${unconfirmed.join(", or ")}. It may have gone through, so check it before you try again.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function nonExecutionRecoveredByLaterSuccess(
  log: ChatRunState["toolCallsLog"],
  index: number,
): boolean {
  const entry = log[index];

  if (!entry?.nonExecution) return false;

  return log
    .slice(index + 1)
    .some((later) => later.toolName === entry.toolName && later.status === "succeeded");
}

/**
 * Honesty guard (#346): a failed write must not finalize under a "done" reply.
 * Notes each failed write once. Failed reads are skipped, judged per call.
 * The reply is replaced only when it claims a failed write succeeded. Otherwise it stays
 * the answer: one that reports the failure finalizes as is, and a silent one gets a
 * short note appended here. No second model turn runs, so the kept answer cannot move
 * into narration through a later tool call.
 */
export async function guardUnreportedToolFailures(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  transcript: TranscriptMessage[],
  deps: Partial<GuardUnreportedToolFailuresDeps> = {},
): Promise<StepResult<ChatRunState> | null> {
  const guardDeps = withDefaults(defaultGuardUnreportedToolFailuresDeps, deps);

  const candidates = state.toolCallsLog.filter(
    (t, index) =>
      t.status === "failed" &&
      // Skip a never-executed call only when a later call of the same tool succeeded.
      !nonExecutionRecoveredByLaterSuccess(state.toolCallsLog, index) &&
      !state.notedFailureToolCallIds.includes(t.toolCallId),
  );

  const unreported = candidates.length > 0 ? await guardDeps.selectWrites(ctx, candidates) : [];

  if (unreported.length === 0) return null;

  state.notedFailureToolCallIds = [
    ...state.notedFailureToolCallIds,
    ...unreported.map((t) => t.toolCallId),
  ];

  // With no answer on screen there is nothing to keep, so skip the check.
  const hadReply = state.assistantText.trim().length > 0;

  const judged = !hadReply
    ? ({ verdict: "claims_success", note: "" } as const)
    : await guardDeps.judgeReply({
        userId: ctx.userId,
        runId: ctx.runId,
        threadId: state.threadId,
        reply: state.assistantText,
        failed: unreported,
      });

  if (judged?.verdict === "reports_failure") return null;

  // A failed check keeps the answer too: losing it is the worse error.
  if (judged === null || judged.verdict === "silent") {
    const note = sanitizeVoice(judged?.note.trim() || fallbackFailureNote(unreported));
    const addendum = `\n\n${note}`;

    state.assistantText += addendum;
    await publishSegmentDelta(ctx, state, guardDeps.publish, addendum);

    return null;
  }

  await closePrematureAnswerSegment(ctx, state, guardDeps.publish);

  const names = [...new Set(unreported.map((t) => t.toolName))].join(", ");

  // With no reply there is nothing to withdraw or restate.
  const withdrawal = hadReply
    ? "Your previous reply is withdrawn because it presents a failed attempt as done; the user no longer sees it as the answer. " +
      "Write the complete reply again. Restate in full everything from it that is still true, and do not point to it ('above', 'as I said'). "
    : "";

  const unconfirmed = [
    ...new Set(unreported.filter((t) => t.effectUnconfirmed).map((t) => t.toolName)),
  ].join(", ");

  // The model must not turn "not confirmed" into "nothing changed".
  const unconfirmedNote = unconfirmed
    ? `For ${unconfirmed}, an attempt may have reached the target and nothing confirmed it: do not say that nothing changed. Tell the user to check it before trying again. `
    : "";

  const note =
    `These action attempts did not complete this turn — their tool calls failed: ${names}. ` +
    unconfirmedNote +
    withdrawal +
    "Do NOT tell the user a failed attempt succeeded. If a later successful tool result in the transcript completed the user's goal another way, say what succeeded and mention any meaningful limitation. " +
    "Otherwise, say plainly, in user terms, what you couldn't do and the best next step. Hide the mechanism (tool names, error details), never the outcome.";

  return {
    kind: "next",
    state,
    transcript: appendSystemNote(transcript, note),
    nextStep: "chat-turn",
  };
}

/** One guard in {@link FINALIZE_GUARD_SEQUENCE}. */
interface FinalizeGuard {
  /** Only for the error message when a guard throws; never user-visible. */
  readonly id: string;
  readonly run: (
    ctx: StepContext<ChatRunState>,
    state: ChatRunState,
    transcript: TranscriptMessage[],
  ) => Promise<StepResult<ChatRunState> | null>;
}

/**
 * Guard order; the first non-null result wins. Children go first: a turn that
 * parks on a child must not spend a regeneration on the honesty note.
 */
export const FINALIZE_GUARD_SEQUENCE: readonly FinalizeGuard[] = [
  {
    id: "spawned_children",
    run: (ctx, state, transcript) => guardSpawnedChildren(ctx, state, transcript),
  },
  {
    id: "unreported_tool_failures",
    run: (ctx, state, transcript) => guardUnreportedToolFailures(ctx, state, transcript),
  },
];

/** The one effect the finalize boundary cannot perform for itself. */
export interface FinalizeBoundaryDeps {
  /** `releaseWithheldReply` from `./stream-model-turn`. Only the step that holds the stream has it. */
  readonly releaseWithheldReply: () => Promise<void>;
}

/**
 * Run everything a turn with visible text must do before it completes.
 * Returns the first guard result that takes over, or `null`.
 */
export async function crossFinalizeBoundary(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  transcript: TranscriptMessage[],
  deps: FinalizeBoundaryDeps,
): Promise<StepResult<ChatRunState> | null> {
  // The model answered instead of reissuing (#407), so release the real reply.
  // Clear the flag first: the flush gate reads it. Release before the guards move the segment.
  if (state.reissuePending) {
    state.reissuePending = false;
    await deps.releaseWithheldReply();
  }

  // A guard may regenerate, and that turn needs fresh budgets.
  resetChatTurnRetryBudgets(state);

  for (const guard of FINALIZE_GUARD_SEQUENCE) {
    const result = await guard.run(ctx, state, transcript);

    if (result) return result;
  }

  return null;
}
