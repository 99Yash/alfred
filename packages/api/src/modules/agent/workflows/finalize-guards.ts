import {
  isRecord,
  SPAWN_SUB_AGENT_TOOL,
  withDefaults,
  type AgentTranscriptMessage,
} from "@alfred/contracts";
import { publishEvent } from "../../../events/publish";
import { isMutatingToolName } from "../../tool-runtime";
import { joinChildRun, type JoinChildRunDeps, type ParkSignal } from "../sub-agent-join";
import { scheduleSubAgentJoinWakeJob } from "../sub-agent-join-wake-queue";
import {
  isTerminalChildStatus,
  listSpawnedChildRuns,
  readChildRunOutcome,
  type ChildRunOutcome,
} from "../sub-agents";
import type { StepContext, StepResult } from "../types";
import { closeNarrationSegment, interruptChatRun, type ChatRunState } from "./chat-turn-state";
import { PREVIEW_CHARS } from "./tool-preview";
import { resetChatTurnRetryBudgets } from "./turn-budgets";

/**
 * The chat turn's finalize boundary: everything that has to happen between "the
 * model produced an answer" and "the turn may persist it and complete", in the
 * order it happens.
 *
 * Each guard returns a `StepResult` to take over finalization (park, or
 * regenerate an informed/honest answer) or `null` to stand aside. They have
 * identical signatures, which is exactly why the order needs to be *data*:
 * before {@link FINALIZE_GUARD_SEQUENCE} the ordering lived only in the
 * comments between two consecutive `await`s, and a caller could reorder them
 * without anything complaining.
 *
 * The guards' own preconditions were the same hazard one step earlier — two
 * bare statements the workflow ran under a comment saying they had to come
 * first. {@link crossFinalizeBoundary} is the whole boundary, so the only way
 * to reach a guard is through the work that has to precede it.
 */

/**
 * The `childRunId` argument of a `system.await_sub_agent` call, if present. A
 * successful await hands the boss the child's real outcome as a normal tool
 * result in-transcript, so the child is already accounted for — see the
 * finalization-guard accounting at the dispatch-tools commit pass.
 */
export function awaitedChildRunId(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const id = input.childRunId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** Truncated, model-readable rendering of a folded child's output/error. */
function renderChildOutcome(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/**
 * Synthetic transcript turn folding a finished-but-unawaited child's outcome
 * back to the boss, so a regenerated answer is informed by it. Phrased as a
 * system note in a user turn (there is no matching tool-call id to attach a real
 * tool result to — the boss never called `await_sub_agent`).
 */
function syntheticChildResultMessage(
  childRunId: string,
  outcome: ChildRunOutcome,
): AgentTranscriptMessage {
  if (!isTerminalChildStatus(outcome.status)) {
    // Folded WITHOUT a terminal result: the join gave up parking because it
    // couldn't schedule the dead-man timer ("disabled"/"failed") or the child
    // outran the wait-ceiling. Tell the boss to answer honestly with what it has
    // rather than inventing a result it never received.
    const why = outcome.reason ? ` (${outcome.reason})` : ` (still ${outcome.status})`;
    return {
      role: "user",
      content:
        `[system] A sub-agent you spawned (childRunId ${childRunId}) could not be awaited${why}. ` +
        "Answer now with what you already have. Tell the user that part of the work is still in progress; do not fabricate its result.",
    } satisfies AgentTranscriptMessage;
  }
  const detail =
    outcome.status === "completed"
      ? `completed with result:\n${renderChildOutcome(outcome.output)}`
      : outcome.status === "failed"
        ? `failed: ${renderChildOutcome(outcome.error)}`
        : outcome.status; // cancelled / other terminal
  return {
    role: "user",
    content:
      `[system] A sub-agent you spawned (childRunId ${childRunId}) finished without you awaiting it — it ${detail}. ` +
      "Incorporate this into your answer now. Do not say you will follow up when it finishes; it already has.",
  } satisfies AgentTranscriptMessage;
}

/**
 * Close the model's premature (uninformed / possibly false-success) answer into a
 * narration segment and advance the live client off it, shared by both finalize
 * guards. The trigger differs — an uninformed child-await answer vs a
 * false-success tool-failure answer — but the closure is identical: the segment
 * close below, then a zero-length `chat.delta` on the new segment.
 *
 * The zero-length delta is load-bearing: that premature text already streamed to
 * the client as a `chat.delta`, and `use-chat-stream` only advances `currentSegment`
 * on a HIGHER-segment delta. Without it the client keeps rendering the answer the
 * guard just rejected as the live reply — the premature text drops into the
 * narration trail (matching the server state we just wrote) and the live answer
 * area clears back to the working indicator until the informed reply streams in.
 *
 * Returns whether it closed (non-empty text) so `guardSpawnedChildren` can keep its
 * transcript-tail strip decision; `guardUnreportedToolFailures` ignores the result.
 * `publish` is injected (both guards resolve it to `publishEvent`) so the guards'
 * tests keep working without a live event bus.
 */
async function closePrematureAnswerSegment(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  publish: typeof publishEvent,
): Promise<boolean> {
  // The turn's other close is `closeLeadInNarration`; these two fields are the
  // whole difference between them (see `NarrationClose` in `./chat-turn-state`).
  // Rejected prose already streamed, so it is kept; and with nothing closed
  // there is no new segment for the delta below to advance the client onto.
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
      text: "",
      segmentIndex: state.segmentIndex,
    },
  });
  return true;
}

/**
 * The I/O is injectable purely so the runtime invariant can be unit-tested
 * (timer-scheduling failure, ceiling expiry, terminal folding, the live segment
 * transition) without a DB or Redis; production always uses the real impls.
 * `readOutcome`/`scheduleWake` are forwarded to {@link joinChildRun}, which owns
 * the sequence they participate in.
 */
export interface GuardSpawnedChildrenDeps extends JoinChildRunDeps {
  listChildren: typeof listSpawnedChildRuns;
  publish: typeof publishEvent;
}

const defaultGuardSpawnedChildrenDeps: GuardSpawnedChildrenDeps = {
  listChildren: listSpawnedChildRuns,
  readOutcome: readChildRunOutcome,
  scheduleWake: scheduleSubAgentJoinWakeJob,
  publish: publishEvent,
};

/**
 * ADR-0073 finalization guard (#268 runtime invariant). The prompt tells the
 * boss to `await_sub_agent` every child it spawns, but a prompt is not a
 * guarantee — if it skips the await and tries to finalize, the parent would
 * answer while its children still run (the abandonment bug). This makes the
 * await load-bearing at the finalize boundary:
 *
 *  - Folds every newly-terminal spawned child's outcome into the transcript so a
 *    regenerated reply is actually informed by it.
 *  - If any spawned child is still running, parks the turn on its completion
 *    signal (with a dead-man timer backstop) instead of finalizing — the turn
 *    CANNOT complete while a child it spawned is non-terminal.
 *  - Once all children are terminal and folded, loops back to regenerate an
 *    informed answer (bounded by `CHAT_TURN_CAP_MAX`).
 *
 * The park-or-fold decision per child is {@link joinChildRun}, shared verbatim
 * with the `await_sub_agent` tool — including the rule that a child which cannot
 * get a dead-man timer is folded rather than parked on.
 *
 * Returns a `StepResult` to take over finalization, or `null` to let the caller
 * finalize normally. Gated on an actual spawn this turn, so a turn with no
 * sub-agents pays nothing.
 */
export async function guardSpawnedChildren(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  transcript: AgentTranscriptMessage[],
  deps: GuardSpawnedChildrenDeps = defaultGuardSpawnedChildrenDeps,
): Promise<StepResult<ChatRunState> | null> {
  const spawnedThisTurn = state.toolCallsLog.some(
    (t) => t.toolName === SPAWN_SUB_AGENT_TOOL && t.status === "succeeded",
  );
  if (!spawnedThisTurn) return null;

  const children = await deps.listChildren(ctx.runId);
  const unfolded = children.filter((c) => !state.foldedChildRunIds.includes(c.id));
  if (unfolded.length === 0) return null;

  const foldMessages: AgentTranscriptMessage[] = [];
  // The signals the join minted, not the child ids — the park below can only be
  // built from something {@link joinChildRun} handed back, so this guard never
  // re-derives a signal name it might not have earned a timer for.
  const parkSignals: ParkSignal[] = [];

  for (const child of unfolded) {
    const join = await joinChildRun(
      { parentRunId: ctx.runId, userId: ctx.userId, childRunId: child.id },
      deps,
    );
    if (join.kind === "park") {
      parkSignals.push(join.signalName);
      continue;
    }
    // Resolved: a real result, or an honest still-running note (ceiling expiry /
    // `join_timer_unavailable`). Either way stop tracking the child — that is
    // what keeps a stuck child from re-parking forever.
    foldMessages.push(syntheticChildResultMessage(child.id, join.outcome));
    state.foldedChildRunIds = [...state.foldedChildRunIds, child.id];
  }

  // Close the model's premature (uninformed) answer into a narration segment so
  // the eventual informed reply lands in a fresh segment instead of appending to
  // the abandoned text, and advance the live client off it. (At the finalize
  // boundary `assistantText` is always non-empty; the guard only runs after the
  // empty-text check. `closePrematureAnswerSegment` still gates on non-empty
  // text to stay correct if re-ordered.)
  const closedPrematureAnswer = await closePrematureAnswerSegment(ctx, state, deps.publish);

  // The premature assistant answer we just closed into narration is still the
  // tail of `transcript` (`appendModelResponseMessages` appended it before the
  // guard ran). Drop it so the transcript we forward never ends in that
  // assistant message. This is load-bearing on the PARK path: the parked
  // transcript becomes `ctx.transcript` and the resumed step re-invokes the
  // model with it (top of `chat-turn`) BEFORE this guard runs again to fold the
  // now-terminal child. A transcript ending in an assistant message is an
  // illegal prefill under extended thinking — Anthropic 400s with "the
  // conversation must end with a user message", which previously retried 9× and
  // failed the turn ("Something interrupted this reply."). Stripping it leaves
  // the tail at the tool results (park with no folds) or the synthetic user
  // fold (folds present), both legal turn-enders, and keeps the regenerated
  // reply from being anchored to the uninformed answer. `state.narration`
  // already carries that text for the UI, so nothing is lost.
  const baseTranscript =
    closedPrematureAnswer && transcript.at(-1)?.role === "assistant"
      ? transcript.slice(0, -1)
      : transcript;
  const nextTranscript =
    foldMessages.length > 0 ? [...baseTranscript, ...foldMessages] : baseTranscript;

  if (parkSignals.length > 0) {
    return interruptChatRun(state, nextTranscript, { kind: "signal", name: parkSignals[0]! });
  }
  return { kind: "next", state, transcript: nextTranscript, nextStep: "chat-turn" };
}

export interface GuardUnreportedToolFailuresDeps {
  isMutating: (toolName: string) => boolean;
  publish: typeof publishEvent;
}

const defaultGuardUnreportedToolFailuresDeps: GuardUnreportedToolFailuresDeps = {
  isMutating: isMutatingToolName,
  publish: publishEvent,
};

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
 * #346 honesty guard. The completion path only checks that the assistant
 * produced *some* text — nothing structurally stops a weak model from streaming
 * "I've created your spreadsheet" over a turn whose every write failed (trace
 * `run_9ff8bcw13vba`: 4 failed Sheets writes, final text claimed success). The
 * boss prompt now forbids this, but a prompt is not a guarantee; this makes it
 * load-bearing at the finalize boundary, mirroring {@link guardSpawnedChildren}:
 *
 *  - Finds mutating tool calls that failed this run. Reads (`no_risk`) are
 *    excluded: a failed lookup doesn't tempt a false "done" the way a failed
 *    write does, and regenerating for it would waste a turn. A later successful
 *    call is not proof of recovery unless the model can explain the recovery
 *    from the transcript; same tool names can target different side effects.
 *  - For any not yet surfaced, injects a `[system]` note naming them and telling
 *    the boss not to claim they succeeded, then loops back to regenerate an honest
 *    answer (bounded by `CHAT_TURN_CAP_MAX`).
 *  - Records the handled toolCallIds in `notedFailureToolCallIds` so it fires at
 *    most once per failure — the regenerated turn sees them as noted and finalizes,
 *    so there is no loop. (A genuinely new mutating failure on the regenerated turn
 *    is a fresh toolCallId and is correctly surfaced again.)
 *
 * Returns a `StepResult` to take over finalization, or `null` to let the caller
 * finalize normally. A turn with no failed mutating calls pays nothing.
 *
 * `isMutating`/`publish` are injectable purely so the invariant can be unit-tested
 * (the registry is populated at boot) without a live tool registry or event bus.
 */
export async function guardUnreportedToolFailures(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  transcript: AgentTranscriptMessage[],
  deps: Partial<GuardUnreportedToolFailuresDeps> = {},
): Promise<StepResult<ChatRunState> | null> {
  const guardDeps = withDefaults(defaultGuardUnreportedToolFailuresDeps, deps);
  const unreported = state.toolCallsLog.filter(
    (t, index) =>
      t.status === "failed" &&
      // A schema-invalid / unknown-tool call never executed a side effect — the
      // model may self-correct it, and the prompt says not to narrate internal
      // retries. Skip only when the log shows that correction actually happened;
      // a lone malformed write call can still lead to a false "done" answer.
      !nonExecutionRecoveredByLaterSuccess(state.toolCallsLog, index) &&
      !state.notedFailureToolCallIds.includes(t.toolCallId) &&
      guardDeps.isMutating(t.toolName),
  );
  if (unreported.length === 0) return null;

  state.notedFailureToolCallIds = [
    ...state.notedFailureToolCallIds,
    ...unreported.map((t) => t.toolCallId),
  ];

  // Close the premature (possibly false-success) answer into a narration segment
  // so the regenerated honest reply lands in a fresh segment instead of appending
  // to the rejected text, and advance the client off it with a zero-length delta.
  // Same closure protocol as guardSpawnedChildren; this guard doesn't need the
  // return value (no transcript-tail strip here).
  await closePrematureAnswerSegment(ctx, state, guardDeps.publish);

  const names = [...new Set(unreported.map((t) => t.toolName))].join(", ");
  const note: AgentTranscriptMessage = {
    role: "user",
    content:
      `[system] These action attempts did not complete this turn — their tool calls failed: ${names}. ` +
      "Do NOT tell the user a failed attempt succeeded. If a later successful tool result in the transcript completed the user's goal another way, say what succeeded and mention any meaningful limitation. " +
      "Otherwise, say plainly, in user terms, what you couldn't do and the best next step. Hide the mechanism (tool names, error details), never the outcome.",
  } satisfies AgentTranscriptMessage;

  return { kind: "next", state, transcript: [...transcript, note], nextStep: "chat-turn" };
}

/** One guard in {@link FINALIZE_GUARD_SEQUENCE}. */
interface FinalizeGuard {
  /** Only for the error message when a guard throws; never user-visible. */
  readonly id: string;
  readonly run: (
    ctx: StepContext<ChatRunState>,
    state: ChatRunState,
    transcript: AgentTranscriptMessage[],
  ) => Promise<StepResult<ChatRunState> | null>;
}

/**
 * The declared order every chat turn's finalize boundary runs its guards in.
 *
 * The two guards have identical signatures, so nothing but this list stops a
 * caller from reordering them, and the order is not arbitrary:
 * `guardSpawnedChildren` may PARK the turn on a still-running child, and a
 * parked turn must not first have spent a regeneration on the honesty note —
 * that note would be re-injected on the resumed turn against a transcript the
 * child's fold has since changed. The child guard also strips the premature
 * assistant tail from the transcript it forwards, which the honesty guard's
 * append then builds on. So: children first, honesty second.
 *
 * A guard added here inherits both properties (first non-null wins, order is
 * reviewable as data) rather than becoming a third `await` in a comment chain.
 */
export const FINALIZE_GUARD_SEQUENCE: readonly FinalizeGuard[] = [
  {
    // ADR-0073 runtime invariant: before completing, never let the parent answer
    // while a sub-agent it spawned is still running.
    id: "spawned_children",
    run: (ctx, state, transcript) => guardSpawnedChildren(ctx, state, transcript),
  },
  {
    // #346 honesty guard: never finalize a turn that claims success while a
    // mutating tool call net-failed.
    id: "unreported_tool_failures",
    run: (ctx, state, transcript) => guardUnreportedToolFailures(ctx, state, transcript),
  },
];

/** The one effect the finalize boundary cannot perform for itself. */
export interface FinalizeBoundaryDeps {
  /**
   * Release the reply deltas the #407 reissue gate withheld during the drain.
   * This is `releaseWithheldReply` from `./stream-model-turn`, which only the
   * step holding the live stream can hand over; the boundary calls it (after
   * clearing the flag) before any guard runs, so the caller never does.
   */
  readonly releaseWithheldReply: () => Promise<void>;
}

/**
 * Cross the chat turn's finalize boundary: everything a turn that produced
 * user-visible text must do before it is allowed to persist and complete.
 * Returns the first result that takes over finalization, or `null` when the
 * boundary is clear and the caller may complete the turn.
 *
 * Three things happen here, in this order, and the order is why they are one
 * function instead of three statements above the loop:
 *
 *  1. **Release a withheld reply.** If a reissue was pending (#407) the model
 *     answered instead of reissuing, so this text is the real reply, not an
 *     internal lead-in. Clear the flag — the stream's flush gate reads it, so
 *     releasing first silently publishes nothing — then release. This must
 *     precede the guards: a guard closes `assistantText` into a narration
 *     segment and bumps `segmentIndex`, and deltas released afterwards would
 *     land on the wrong segment, on text the guard already rejected.
 *  2. **Refresh the retry budgets.** Both guards can regenerate another chat
 *     turn, and that turn must start with a fresh consecutive-failure budget.
 *  3. **Run {@link FINALIZE_GUARD_SEQUENCE}.**
 *
 * Guards mutate `state` in place and each sees the transcript as the caller
 * built it; a guard that takes over owns the transcript it returns, so no later
 * guard runs against a transcript a taking-over guard has already rewritten.
 */
export async function crossFinalizeBoundary(
  ctx: StepContext<ChatRunState>,
  state: ChatRunState,
  transcript: AgentTranscriptMessage[],
  deps: FinalizeBoundaryDeps,
): Promise<StepResult<ChatRunState> | null> {
  if (state.reissuePending) {
    state.reissuePending = false;
    await deps.releaseWithheldReply();
  }
  resetChatTurnRetryBudgets(state);

  for (const guard of FINALIZE_GUARD_SEQUENCE) {
    const result = await guard.run(ctx, state, transcript);
    if (result) return result;
  }
  return null;
}
