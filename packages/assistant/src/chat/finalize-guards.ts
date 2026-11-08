import type { TranscriptMessage } from "@alfred/ai";
import {
  INTEGRATION_SLUGS,
  isActionTool,
  mcpCallInput,
  SPAWN_SUB_AGENT_TOOL,
  toDisplayText,
  withDefaults,
} from "@alfred/contracts";
import { publishEvent } from "@alfred/assistant/triggers";
import { isSelectedMcpToolReadOnly } from "@alfred/assistant/tool-runtime/mcp";
import { db } from "@alfred/db";
import { actionStagings, mcpInvocation } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import {
  isTerminalChildStatus,
  joinChildOutcome,
  listSpawnedChildRuns,
  PREVIEW_CHARS,
  appendSystemNote,
  resetChatTurnRetryBudgets,
  scheduleSubAgentJoinWakeJob,
  type ChildRunOutcome,
  type ParkWake,
  type StepContext,
  type StepResult,
} from "@alfred/assistant/execution";
import { closeNarrationSegment, interruptChatRun, type ChatRunState } from "./chat-turn-state";
import { judgeFailedWriteReport } from "./failed-write-report";

/**
 * The work between "the model answered" and "the turn may complete".
 * Each guard returns a `StepResult` to take over (park or regenerate), or `null`.
 */

/** Truncated, model-readable rendering of a folded child's output/error. */
function renderChildOutcome(value: unknown): string {
  const text = toDisplayText(value);

  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/** A note that hands an unawaited child's outcome to the boss. No tool call exists to attach it to. */
function syntheticChildResultNote(childRunId: string, outcome: ChildRunOutcome): string {
  if (!isTerminalChildStatus(outcome.status)) {
    // The join gave up: no dead-man timer, or the child outran the wait ceiling.
    const why = outcome.reason ? ` (${outcome.reason})` : ` (still ${outcome.status})`;

    return (
      `A sub-agent you spawned (childRunId ${childRunId}) could not be awaited${why}. ` +
      "Answer now with what you already have. Tell the user that part of the work is still in progress; do not fabricate its result."
    );
  }

  const detail =
    outcome.status === "completed"
      ? `completed with result:\n${renderChildOutcome(outcome.output)}`
      : outcome.status === "failed"
        ? `failed: ${renderChildOutcome(outcome.error)}`
        : outcome.status; // cancelled / other terminal

  return (
    `A sub-agent you spawned (childRunId ${childRunId}) finished without you awaiting it — it ${detail}. ` +
    "Incorporate this into your answer now. Do not say you will follow up when it finishes; it already has."
  );
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
      text: "",
      segmentIndex: state.segmentIndex,
    },
  });

  return true;
}

/** Injectable I/O for tests. `scheduleWake` goes to {@link joinChildOutcome}. */
export interface GuardSpawnedChildrenDeps {
  listChildren: typeof listSpawnedChildRuns;
  scheduleWake: typeof scheduleSubAgentJoinWakeJob;
  publish: typeof publishEvent;
}

const defaultGuardSpawnedChildrenDeps: GuardSpawnedChildrenDeps = {
  listChildren: listSpawnedChildRuns,
  scheduleWake: scheduleSubAgentJoinWakeJob,
  publish: publishEvent,
};

/**
 * The parent never answers while a child it spawned still runs (ADR-0073).
 * Park on a running child; fold finished ones and regenerate. The list reads each child one
 * time, and {@link joinChildOutcome} decides park or fold, the same as `await_sub_agent`.
 */
export async function guardSpawnedChildren(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  transcript: TranscriptMessage[],
  deps: GuardSpawnedChildrenDeps = defaultGuardSpawnedChildrenDeps,
): Promise<StepResult<ChatRunState> | null> {
  const spawnedThisTurn = state.toolCallsLog.some(
    (t) => t.toolName === SPAWN_SUB_AGENT_TOOL && t.status === "succeeded",
  );

  if (!spawnedThisTurn) return null;

  const children = await deps.listChildren({ parentRunId: ctx.runId, userId: ctx.userId });
  const unfolded = children.filter((c) => !state.foldedChildRunIds.includes(c.id));

  if (unfolded.length === 0) return null;

  const foldNotes: string[] = [];
  // Only wakes the join returned: each one carries a persisted deadline.
  const parkWakes: ParkWake[] = [];

  for (const child of unfolded) {
    const join = await joinChildOutcome(child, deps);

    if (join.kind === "park") {
      parkWakes.push(join.wake);
      continue;
    }

    // Stop tracking a resolved child, so a stuck one cannot re-park forever.
    foldNotes.push(syntheticChildResultNote(child.id, join.outcome));
    state.foldedChildRunIds = [...state.foldedChildRunIds, child.id];
  }

  const closedPrematureAnswer = await closePrematureAnswerSegment(ctx, state, deps.publish);

  // Drop the rejected answer from the tail. A resumed park sends this transcript to
  // the model, and with extended thinking Anthropic 400s on a trailing assistant message.
  const baseTranscript =
    closedPrematureAnswer && transcript.at(-1)?.role === "assistant"
      ? transcript.slice(0, -1)
      : transcript;

  const nextTranscript = foldNotes.reduce<TranscriptMessage[]>(
    (acc, note) => appendSystemNote(acc, note),
    [...baseTranscript],
  );

  const [firstParkWake] = parkWakes;

  if (firstParkWake) {
    return interruptChatRun(state, nextTranscript, firstParkWake);
  }

  return { kind: "next", state, transcript: nextTranscript, nextStep: "chat-turn" };
}

type ToolCallLogEntry = ChatRunState["toolCallsLog"][number];

export interface GuardUnreportedToolFailuresDeps {
  /** Whether this failed call may have been a write. Judged per call, not per tool name. */
  isWrite: (ctx: StepContext<ChatRunState>, call: ToolCallLogEntry) => Promise<boolean>;
  judgeReply: typeof judgeFailedWriteReport;
  publish: typeof publishEvent;
}

/**
 * `mcp.call` is one name for every remote tool, so its name says nothing. Judge the
 * selected remote tool at the revision the call named. A call with no staging row or
 * no parseable input stays a write: guessing "read" would hide a failure.
 */
async function isWriteCall(ctx: StepContext<ChatRunState>, call: ToolCallLogEntry) {
  if (call.toolName !== "mcp.call") return isActionTool(call.toolName);

  const [row] = await db()
    .select({ input: actionStagings.proposedInput, decidedInput: actionStagings.decidedInput })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.userId, ctx.userId),
        eq(actionStagings.runId, ctx.runId),
        eq(actionStagings.toolCallId, call.toolCallId),
      ),
    )
    .limit(1);

  // The broker reads the same pair, so this names the tool that ran.
  const parsed = mcpCallInput.safeParse(row?.decidedInput ?? row?.input);

  if (!parsed.success) return true;

  return !(await isSelectedMcpToolReadOnly({ userId: ctx.userId, ...parsed.data }));
}

const defaultGuardUnreportedToolFailuresDeps: GuardUnreportedToolFailuresDeps = {
  isWrite: isWriteCall,
  judgeReply: judgeFailedWriteReport,
  publish: publishEvent,
};

/** Open a paragraph on the kept answer, live and in state, so the note does not run on. */
async function openAddendumParagraph(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  publish: typeof publishEvent,
): Promise<void> {
  const separator = "\n\n";

  state.assistantText += separator;
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
      text: separator,
      segmentIndex: state.segmentIndex,
    },
  });
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
 * the answer: one that already reports the failure finalizes, and a silent one gets a note.
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

  const unreported: ToolCallLogEntry[] = [];

  for (const call of candidates) {
    if (await guardDeps.isWrite(ctx, call)) unreported.push(call);
  }

  if (unreported.length === 0) return null;

  state.notedFailureToolCallIds = [
    ...state.notedFailureToolCallIds,
    ...unreported.map((t) => t.toolCallId),
  ];

  const names = [...new Set(unreported.map((t) => t.toolName))].join(", ");

  const failedFact =
    `These action attempts did not complete this turn — their tool calls failed: ${names}. ` +
    "Hide the mechanism (tool names, error details), never the outcome.";

  // With no answer on screen there is nothing to keep, so skip the check.
  const verdict =
    state.assistantText.trim().length === 0
      ? "claims_success"
      : await guardDeps.judgeReply({
          userId: ctx.userId,
          runId: ctx.runId,
          threadId: state.threadId,
          reply: state.assistantText,
          failed: unreported,
        });

  if (verdict === "reports_failure") return null;

  if (verdict === "silent") {
    // The answer stays in `content`. The next turn appends to this segment.
    await openAddendumParagraph(ctx, state, guardDeps.publish);

    const note =
      `${failedFact} Your reply above stays on screen as written. Do not repeat, restate, or summarize it. ` +
      "Write only a short closing note, in user terms: what you couldn't do and the best next step. " +
      "If the reply above implies a failed attempt succeeded, correct that first. " +
      "If a later successful tool result completed the user's goal another way, say so instead.";

    return {
      kind: "next",
      state,
      transcript: appendSystemNote(transcript, note),
      nextStep: "chat-turn",
    };
  }

  await closePrematureAnswerSegment(ctx, state, guardDeps.publish);

  const note =
    `${failedFact} Your previous reply is withdrawn because it presents a failed attempt as done; the user no longer sees it as the answer. ` +
    "Write the complete reply again. Restate in full everything from it that is still true, and do not point to it ('above', 'as I said'). " +
    "Do NOT tell the user a failed attempt succeeded. If a later successful tool result in the transcript completed the user's goal another way, say what succeeded and mention any meaningful limitation. " +
    "Otherwise, say plainly what you couldn't do and the best next step.";

  return {
    kind: "next",
    state,
    transcript: appendSystemNote(transcript, note),
    nextStep: "chat-turn",
  };
}

/** A successful catalog read and a completed remote call are different evidence. */
export async function guardFalseProvenance(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  transcript: TranscriptMessage[],
): Promise<StepResult<ChatRunState> | null> {
  // No latch: a repeated false claim must trip it again. The turn cap bounds the loop.
  const reply = state.assistantText;

  const claimsMcpUse =
    /\b(?:used|using|called|queried|via|through)\b.{0,65}\bMCP\b(?! catalog)/i.test(reply) ||
    /\bMCP tool\b.{0,65}\b(?:returned|showed|provided|gave)\b/i.test(reply);

  const claimsCatalog =
    /\b(?:MCP|connection|connected server)\b.{0,90}\b(?:exposes?|offers?|provides?|has|lacks?|does not|doesn't)\b.{0,90}\b(?:tools?|capabilit\w*|metrics?|data|logs?|deployments?|CPU|RAM)\b/i.test(
      reply,
    ) || /\b(?:checked|read|searched)\b.{0,65}\b(?:MCP|tool) catalog\b/i.test(reply);

  const unsupportedIntegrations = INTEGRATION_SLUGS.filter((slug) => {
    if (slug === "mcp" || slug === "system") return false;

    const claim = new RegExp(
      `\\b(?:used|using|called|queried|via|through)\\b.{0,55}\\b${slug}\\b`,
      "i",
    ).exec(reply);

    if (!claim || /\b(?:not|never|didn't|couldn't|cannot)\b/i.test(claim[0])) return false;

    // The provider name can precede "MCP"; inspect the next words as well.
    // That phrase is a transport claim, which the invocation check owns.
    const sourcePhrase = reply.slice(claim.index, claim.index + claim[0].length + 20);

    if (/\bMCP\b/i.test(sourcePhrase)) return false;

    return !state.toolCallsLog.some(
      (call) => call.status === "succeeded" && call.toolName.startsWith(`${slug}.`),
    );
  });

  if (!claimsMcpUse && !claimsCatalog && unsupportedIntegrations.length === 0) return null;

  const successfulCatalogRead = state.toolCallsLog.some(
    (call) => call.toolName === "mcp.list_tools" && call.status === "succeeded",
  );

  const successfulMcpCallIds = state.toolCallsLog
    .filter((call) => call.toolName === "mcp.call" && call.status === "succeeded")
    .map((call) => call.toolCallId);

  // Match on the staging row, not the invocation's unindexed `toolCallId` copy.
  // The inner join also excludes owner-approved health reads, which have no staging row.
  const completedInvocation =
    claimsMcpUse && successfulMcpCallIds.length > 0
      ? await db()
          .select({ id: mcpInvocation.id })
          .from(mcpInvocation)
          .innerJoin(actionStagings, eq(actionStagings.id, mcpInvocation.stagingId))
          .where(
            and(
              eq(mcpInvocation.userId, ctx.userId),
              eq(actionStagings.runId, ctx.runId),
              inArray(actionStagings.toolCallId, successfulMcpCallIds),
              eq(mcpInvocation.effectOutcome, "succeeded"),
            ),
          )
          .limit(1)
      : [];

  if (
    (!claimsMcpUse || completedInvocation.length > 0) &&
    (!claimsCatalog || successfulCatalogRead) &&
    unsupportedIntegrations.length === 0
  ) {
    return null;
  }

  await closePrematureAnswerSegment(ctx, state, publishEvent);

  const successfulNames = state.toolCallsLog
    .filter((call) => call.status === "succeeded")
    .map((call) => call.toolName);

  const note =
    `Your previous answer claimed a source or described an MCP catalog without the required successful evidence. ` +
    `Successful tool calls this run: ${successfulNames.join(", ") || "none"}. ` +
    `A completed mcp.call with a succeeded mcp_invocation row is required to say you used MCP. ` +
    `A successful mcp.list_tools call is required to state what its catalog offers. ` +
    `Unsupported integration claims: ${unsupportedIntegrations.join(", ") || "none"}. ` +
    `Eight rejected calls or a local registry search do not count. Answer again with only the evidence this run has.`;

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
  {
    id: "false_provenance",
    run: (ctx, state, transcript) => guardFalseProvenance(ctx, state, transcript),
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
