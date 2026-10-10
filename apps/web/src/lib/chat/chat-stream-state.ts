import {
  applyChatDelta,
  createChatDeltaLog,
  type ChatConnectNudge,
  type ChatDeltaLog,
} from "@alfred/contracts";
import type { EventPayload } from "@alfred/contracts/events";
import type { SyncedChatNarration } from "@alfred/sync";
import { frameThreadId, type EventStreamFrame } from "~/lib/events/frame";
import { markChatTimingByAssistant } from "./timing";

/**
 * State machine for the in-flight assistant turn. No React, no DOM.
 * `applyChatFrame` is the only transition and `tickDrip` the only projection.
 * ADR-0073: a sub-agent frame may address a turn but never create one,
 * and a terminal tool card never changes again.
 */

export interface StreamingToolCall {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string | undefined;
  resultPreview?: string | undefined;
  /** `preview()` pruned `resultPreview`, so it is not the whole result. */
  resultTruncated?: boolean | undefined;
  /** ADR-0070: non-text bytes were stripped from this result before storage. */
  sanitized?: boolean | undefined;
  /** Narration segment this call follows. */
  segmentIndex: number;
  /** Client clock at the first and terminal events, for the duration chip. Null while in flight. */
  startedTs: number;
  endedTs: number | null;
}

/**
 * A sub-agent's tool calls, nested under its spawn card.
 * Keyed on `parentToolCallId` alone. That is sound only because the server spawns
 * one child per `(parentRunId, parentToolCallId)` (the `dedupKey` unique index in
 * `execution/sub-agents.ts`). A second child would merge into the first trail unnoticed.
 */
export interface SubAgentTrail {
  /** The parent's `system.spawn_sub_agent` call. */
  parentToolCallId: string;
  /** Write-once at trail creation. */
  subId: string;
  /** Write-once at trail creation. */
  childRunId: string;
  tools: StreamingToolCall[];
  startedTs: number;
  endedTs: number | null;
  outcome: "completed" | "failed" | "cancelled" | null;
  /** The child is parked on an approval or signal. Not terminal; the clock keeps running. */
  waiting: boolean;
}

export interface StreamingMessage {
  messageId: string;
  runId: string;
  /** Eased text of the live segment. Closed segments move into `narration`. */
  text: string;
  narration: SyncedChatNarration[];
  /** Eased reasoning text. */
  reasoning: string;
  /** Thinking still arrives and the reply has not started. */
  reasoningActive: boolean;
  /** Thinking duration, frozen at the first reply token. */
  reasoningMs: number | null;
  tools: StreamingToolCall[];
  /** Repair offers from connection-health bounces, one per integration. The bounced call is retracted. */
  connectNudges: ChatConnectNudge[];
  /** Kept apart from `tools` so a child's steps do not join the boss's trail. */
  subAgents: SubAgentTrail[];
  awaitingApproval: boolean;
  /** Context is being condensed before the next provider call. */
  compacting: boolean;
  /** A capacity error hit before any output; the turn waits out a backoff. */
  awaitingCapacity: boolean;
  /** The synced message replaces this soon. */
  done: boolean;
  /** Client-side stream failure (SSE disconnect, watchdog). */
  error: string | null;
}

interface SubAgentTrailRef extends Omit<SubAgentTrail, "tools"> {
  tools: Map<string, StreamingToolCall>;
}

interface StreamRef {
  messageId: string;
  runId: string;
  /** Outbox serial of the frame that mounted this turn. A replayed older turn cannot replace it. */
  mountId: number;
  /** Full received text per narration segment, deduped across seqs and attempts. */
  text: ChatDeltaLog;
  /** Highest segment index seen. */
  currentSegment: number;
  /** Eased chars shown of `shownSegment`. */
  shown: number;
  shownSegment: number;
  /** Reasoning has one segment, 0. Read it through {@link reasoningText}. */
  reasoningLog: ChatDeltaLog;
  reasoningShown: number;
  reasoningStartTs: number | null;
  reasoningMs: number | null;
  replyStarted: boolean;
  tools: Map<string, StreamingToolCall>;
  /** Keyed by integration slug. */
  connectNudges: Map<string, ChatConnectNudge>;
  /** Keyed by the parent's `spawn_sub_agent` toolCallId. */
  subAgents: Map<string, SubAgentTrailRef>;
  /** childRunId to parentToolCallId. `agent.run` frames carry only the child's run id. */
  subAgentRuns: Map<string, string>;
  awaitingApproval: boolean;
  compacting: boolean;
  awaitingCapacity: boolean;
  done: boolean;
  error: string | null;
  /**
   * The user hit stop locally. Freeze now and drop late frames for this run,
   * so the bubble does not wait on the worker's ~400ms stop-flag poll.
   */
  stopped: boolean;
}

/** Holds at most one in-flight turn for one thread. Frames for other threads are dropped. */
export interface ChatStreamCell {
  readonly threadId: string;
  current: StreamRef | null;
}

export function createChatStreamCell(threadId: string): ChatStreamCell {
  return { threadId, current: null };
}

/**
 * Whether a sub-agent event belongs to the turn on screen. It never mounts one:
 * a child can outlive its parent turn, and a fresh mount would blank the live turn.
 */
export function subAgentEventAddressesStream<
  T extends { messageId: string; runId: string; stopped: boolean },
>(current: T | null, event: { messageId: string; runId: string }): current is T {
  if (!current || current.stopped) return false;

  return current.messageId === event.messageId && current.runId === event.runId;
}

/** Fold one `chat.tool` event into a turn's tool cards. `now` is the frame receipt time. */
export function applyStreamingToolEvent(
  tools: Map<string, StreamingToolCall>,
  event: EventPayload<"chat.tool">,
  now: number,
): void {
  if (event.nonExecution) {
    tools.delete(event.toolCallId);

    return;
  }

  const previous = tools.get(event.toolCallId);

  // A terminal card stays terminal. Resume or reclaim republishes `started`, and SSE is unordered.
  if (event.status === "started" && previous && previous.endedTs !== null) return;
  tools.set(event.toolCallId, {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.status,
    argsPreview: event.argsPreview ?? previous?.argsPreview,
    resultPreview: event.resultPreview ?? previous?.resultPreview,
    resultTruncated: event.resultTruncated ?? previous?.resultTruncated,
    sanitized: event.sanitized ?? previous?.sanitized,
    segmentIndex: event.segmentIndex ?? previous?.segmentIndex ?? 0,
    startedTs: previous?.startedTs ?? now,
    // A replayed terminal event keeps the first end time.
    endedTs: event.status === "started" ? null : (previous?.endedTs ?? now),
  });
}

/**
 * An accepted frame proves the run moves again. Call only after the `stopped`
 * and seq guards, in an arm that returns `true`, or the composer stays disabled.
 */
function clearApprovalWait(ref: StreamRef): void {
  ref.awaitingApproval = false;
}

/**
 * Return the turn's ref, mounting it on the first frame of any kind, because
 * "started" can fire while `/chat` navigates to `/chat/<id>`.
 * Returns `null` for a different turn with a frame id below the live `mountId`
 * (a `Last-Event-ID` replay). The caller must drop that frame.
 */
function ensureStreamRef(
  cell: ChatStreamCell,
  frameId: number,
  messageId: string,
  runId: string,
): StreamRef | null {
  const existing = cell.current;

  if (existing && existing.messageId === messageId && existing.runId === runId) return existing;

  if (existing && frameId < existing.mountId) return null;

  const fresh: StreamRef = {
    messageId,
    runId,
    mountId: frameId,
    text: createChatDeltaLog({ seq: 0, segment: 0 }),
    currentSegment: 0,
    shown: 0,
    shownSegment: 0,
    reasoningLog: createChatDeltaLog({ seq: 0, segment: 0 }),
    reasoningShown: 0,
    reasoningStartTs: null,
    reasoningMs: null,
    replyStarted: false,
    tools: new Map(),
    connectNudges: new Map(),
    subAgents: new Map(),
    subAgentRuns: new Map(),
    awaitingApproval: false,
    compacting: false,
    awaitingCapacity: false,
    done: false,
    error: null,
    stopped: false,
  };

  cell.current = fresh;

  return fresh;
}

/**
 * Apply one validated SSE frame. Returns whether the view must re-project;
 * `false` lets the rAF loop stay parked. Kinds a turn does not read return `false`.
 * The thread check runs before the dispatch, so a new arm gets it for free.
 * `now` has no default: durations are measured at frame receipt.
 */
export function applyChatFrame(
  cell: ChatStreamCell,
  frame: EventStreamFrame,
  now: number,
): boolean {
  const named = frameThreadId(frame);

  if (named !== null && named !== cell.threadId) return false;

  if (frame.kind === "chat.message") {
    const p = frame.payload;
    const r = cell.current;

    // Drop frames for a stopped ref only when they name it. A global `stopped`
    // check would also drop the frame that mounts the next turn.
    if (r !== null && r.stopped && r.messageId === p.messageId && r.runId === p.runId) return false;

    if (p.phase === "started") {
      if (ensureStreamRef(cell, frame.id, p.messageId, p.runId) === null) return false;
      markChatTimingByAssistant(p.messageId, "stream_started_event", undefined, {
        threadId: cell.threadId,
        runId: p.runId,
      });

      return true;
    }

    if (!r || r.messageId !== p.messageId || r.runId !== p.runId) return false;

    if (p.phase === "compaction_started" || p.phase === "compaction_finished") {
      r.compacting = p.phase === "compaction_started";
      // Compaction means the turn moves again. The two labels never show together.
      r.awaitingCapacity = false;

      return true;
    }

    if (p.phase === "capacity_retry") {
      r.awaitingCapacity = true;
      r.compacting = false;

      return true;
    }

    if (p.phase === "completed") {
      markChatTimingByAssistant(p.messageId, "completion_event", undefined, {
        threadId: cell.threadId,
        runId: p.runId,
        summarize: true,
      });
      r.done = true;
      r.awaitingApproval = false;
      r.compacting = false;
      r.awaitingCapacity = false;

      return true;
    }

    // A new phase must fail to compile, not fall into the completion branch.
    const _exhaustive: never = p.phase;

    return _exhaustive;
  }

  if (frame.kind === "chat.reasoning") {
    const p = frame.payload;
    // Mount before the stop check, so a new turn can replace a stopped one.
    const r = ensureStreamRef(cell, frame.id, p.messageId, p.runId);

    if (r === null || r.stopped) return false;

    const applied = applyChatDelta(r.reasoningLog, {
      seq: p.seq,
      attempt: p.attempt,
      fromSeq: p.fromSeq,
      segment: 0,
      text: p.text,
    });

    if (applied === "dropped") return false;
    clearApprovalWait(r);

    // A reclaimed attempt cut the older attempt's thinking.
    if (applied === "rewound") {
      r.reasoningShown = Math.min(r.reasoningShown, reasoningText(r).length);
    }

    if (r.reasoningStartTs === null) r.reasoningStartTs = now;
    markChatTimingByAssistant(
      p.messageId,
      "first_reasoning_frame",
      { seq: p.seq, chars: p.text.length, totalReasoningChars: reasoningText(r).length },
      { threadId: cell.threadId, runId: p.runId },
    );
    markChatTimingByAssistant(
      p.messageId,
      "last_reasoning_frame",
      { seq: p.seq, chars: p.text.length, totalReasoningChars: reasoningText(r).length },
      { threadId: cell.threadId, runId: p.runId, repeat: "update", log: false },
    );

    return true;
  }

  if (frame.kind === "chat.delta") {
    const p = frame.payload;
    const r = ensureStreamRef(cell, frame.id, p.messageId, p.runId);

    if (r === null || r.stopped) return false;

    const segment = p.segmentIndex ?? 0;

    const applied = applyChatDelta(r.text, {
      seq: p.seq,
      attempt: p.attempt,
      fromSeq: p.fromSeq,
      segment,
      text: p.text,
    });

    if (applied === "dropped") return false;
    clearApprovalWait(r);

    // The first reply token freezes the thinking duration.
    if (!r.replyStarted) {
      r.replyStarted = true;

      if (r.reasoningStartTs !== null && r.reasoningMs === null) {
        r.reasoningMs = now - r.reasoningStartTs;
      }
    }

    // A higher segment closes the prior one into the narration trail.
    if (segment > r.currentSegment) r.currentSegment = segment;

    // A reclaimed attempt cut the older attempt's uncommitted text, maybe whole segments.
    if (applied === "rewound") {
      r.currentSegment = Math.max(0, ...r.text.segments.keys());
      r.shown = Math.min(r.shown, (r.text.segments.get(r.shownSegment) ?? "").length);
    }

    const detail = {
      seq: p.seq,
      chars: p.text.length,
      totalTextChars: r.text.segments.get(segment)?.length ?? 0,
    };

    markChatTimingByAssistant(p.messageId, "first_delta_frame", detail, {
      threadId: cell.threadId,
      runId: p.runId,
    });
    markChatTimingByAssistant(p.messageId, "last_delta_frame", detail, {
      threadId: cell.threadId,
      runId: p.runId,
      repeat: "update",
      log: false,
    });

    return true;
  }

  if (frame.kind === "chat.tool") {
    const p = frame.payload;

    // A sub-agent call nests under its spawn card and never mounts a turn.
    if (p.subAgent) {
      const current = cell.current;

      if (!subAgentEventAddressesStream(current, p)) return false;
      // The repair belongs to the turn, so keep it even when the child has no trail.
      let nudged = false;

      if (p.connectNudge) {
        current.connectNudges.set(p.connectNudge.integration, p.connectNudge);
        nudged = true;
      }

      const { parentToolCallId, subId, childRunId } = p.subAgent;
      const existing = current.subAgents.get(parentToolCallId);

      // Do not draw an empty trail for a retraction.
      if (!existing && p.nonExecution) return nudged;

      const trail = existing ?? {
        parentToolCallId,
        subId,
        childRunId,
        tools: new Map<string, StreamingToolCall>(),
        startedTs: now,
        endedTs: null,
        outcome: null,
        waiting: false,
      };

      applyStreamingToolEvent(trail.tools, p, now);
      current.subAgents.set(parentToolCallId, trail);
      current.subAgentRuns.set(childRunId, parentToolCallId);

      return true;
    }

    const r = ensureStreamRef(cell, frame.id, p.messageId, p.runId);

    if (r === null || r.stopped) return false;
    // Every arm below returns `true`.
    clearApprovalWait(r);
    applyStreamingToolEvent(r.tools, p, now);

    if (p.connectNudge) {
      // Never cleared mid-turn. Last write wins, as in `splitPersistedToolCalls` on reload.
      r.connectNudges.set(p.connectNudge.integration, p.connectNudge);

      return true;
    }

    // A retraction still re-projects, with no timing mark.
    if (p.nonExecution) return true;
    markChatTimingByAssistant(
      p.messageId,
      "first_tool_event",
      { toolName: p.toolName, status: p.status },
      { threadId: cell.threadId, runId: p.runId },
    );
    markChatTimingByAssistant(
      p.messageId,
      "last_tool_event",
      { toolName: p.toolName, status: p.status },
      { threadId: cell.threadId, runId: p.runId, repeat: "update", log: false },
    );

    return true;
  }

  if (frame.kind === "agent.run") {
    // A child's finish or park comes only from here. Only runIds mapped from a child's tool event match.
    const p = frame.payload;
    const r = cell.current;

    if (!r || r.stopped) return false;
    const parentToolCallId = r.subAgentRuns.get(p.runId);

    if (!parentToolCallId) return false;
    const trail = r.subAgents.get(parentToolCallId);

    // A finished child never changes again.
    if (!trail || trail.outcome !== null) return false;

    if (p.phase === "completed" || p.phase === "failed" || p.phase === "cancelled") {
      trail.outcome = p.phase;
      trail.endedTs = now;
      trail.waiting = false;

      return true;
    }

    if (p.phase === "interrupted") {
      trail.waiting = true;

      return true;
    }

    // Any other phase unparks the child. Nothing publishes `resumed`; a resumed run emits `step_started`.
    if (!trail.waiting) return false;
    trail.waiting = false;

    return true;
  }

  if (frame.kind === "approval.requested") {
    const p = frame.payload;
    const r = cell.current;

    if (!r || r.stopped || p.runId !== r.runId) return false;
    r.awaitingApproval = true;
    markChatTimingByAssistant(
      r.messageId,
      "approval_requested",
      { approvalId: p.approvalId },
      { threadId: cell.threadId, runId: r.runId },
    );

    return true;
  }

  return false;
}

/** Cut both buffers at what is shown and mark the turn done and stopped. */
function freezeAndFinalizeTurn(ref: StreamRef, error: string | null): void {
  const eased = anchorEasedSegment(ref);
  // This bypasses the logs' marks. Safe: the ref is `stopped` below, so no later delta reads them.
  ref.text.segments.set(eased.segment, eased.text.slice(0, eased.shown));
  ref.reasoningLog.segments.set(0, reasoningText(ref).slice(0, ref.reasoningShown));

  if (error !== null) ref.error = error;
  ref.stopped = true;
  ref.done = true;
  ref.awaitingApproval = false;
  ref.compacting = false;
  ref.awaitingCapacity = false;
}

/**
 * Optimistic stop: freeze at what is shown and drop later frames for this run.
 * Returns `false` when nothing is in flight or it was already stopped.
 * Closed segments stay in `narration` in full.
 */
export function applyOptimisticStop(cell: ChatStreamCell): boolean {
  const r = cell.current;

  if (!r || r.stopped) return false;
  freezeAndFinalizeTurn(r, null);

  return true;
}

/** The SSE transport died mid-turn. Freeze like a stop and record `error` to show inline. */
export function applyStreamError(cell: ChatStreamCell, message: string): boolean {
  const r = cell.current;

  if (!r || r.stopped) return false;

  // A late CLOSED after `completed` must not turn a finish into a failure.
  if (r.done) return false;
  freezeAndFinalizeTurn(r, message);

  return true;
}

/** A few chars per animation frame, proportional so a big backlog catches up. */
function ease(shown: number, full: number): number {
  return shown < full ? Math.min(full, shown + Math.max(2, Math.ceil((full - shown) / 8))) : shown;
}

function reasoningText(ref: StreamRef): string {
  return ref.reasoningLog.segments.get(0) ?? "";
}

interface EasedSegment {
  segment: number;
  text: string;
  shown: number;
}

/**
 * Reset the eased counter to 0 when the segment advanced, then return them together.
 * Read the counter from here, not `ref.shown`: after a new delta it can describe an older segment.
 */
function anchorEasedSegment(ref: StreamRef): EasedSegment {
  if (ref.shownSegment !== ref.currentSegment) {
    ref.shownSegment = ref.currentSegment;
    ref.shown = 0;
  }

  return {
    segment: ref.shownSegment,
    text: ref.text.segments.get(ref.shownSegment) ?? "",
    shown: ref.shown,
  };
}

/**
 * Ease the buffers one animation frame, then project the view. `null` when nothing is mounted.
 * `caughtUp` tells the caller to stop scheduling frames.
 */
export function tickDrip(
  cell: ChatStreamCell,
): { snapshot: StreamingMessage; caughtUp: boolean } | null {
  const ref = cell.current;

  if (!ref) return null;
  const eased = anchorEasedSegment(ref);
  const shown = ease(eased.shown, eased.text.length);
  const reasoning = reasoningText(ref);
  ref.reasoningShown = ease(ref.reasoningShown, reasoning.length);
  ref.shown = shown;
  const narration: SyncedChatNarration[] = [];

  for (const [index, text] of ref.text.segments) {
    if (index < ref.currentSegment && text.trim().length > 0) narration.push({ index, text });
  }

  narration.sort((a, b) => a.index - b.index);

  return {
    snapshot: {
      messageId: ref.messageId,
      runId: ref.runId,
      text: eased.text.slice(0, shown),
      narration,
      reasoning: reasoning.slice(0, ref.reasoningShown),
      reasoningActive: reasoning.length > 0 && !ref.replyStarted && !ref.done,
      reasoningMs: ref.reasoningMs,
      tools: [...ref.tools.values()],
      connectNudges: [...ref.connectNudges.values()],
      subAgents: [...ref.subAgents.values()].map((trail) => ({
        ...trail,
        tools: [...trail.tools.values()],
      })),
      awaitingApproval: ref.awaitingApproval,
      compacting: ref.compacting,
      awaitingCapacity: ref.awaitingCapacity,
      done: ref.done,
      error: ref.error,
    },
    caughtUp: shown >= eased.text.length && ref.reasoningShown >= reasoning.length,
  };
}

/**
 * Whether two projections render the same. Runs every frame, so it skips
 * write-once fields (`subId`, `childRunId`, `startedTs`). See `SubAgentTrail`.
 */
export function streamSnapshotsEqual(a: StreamingMessage | null, b: StreamingMessage): boolean {
  if (!a) return false;

  if (
    a.messageId !== b.messageId ||
    a.runId !== b.runId ||
    a.text !== b.text ||
    a.reasoning !== b.reasoning ||
    a.reasoningActive !== b.reasoningActive ||
    a.reasoningMs !== b.reasoningMs ||
    a.awaitingApproval !== b.awaitingApproval ||
    a.compacting !== b.compacting ||
    a.awaitingCapacity !== b.awaitingCapacity ||
    a.done !== b.done ||
    a.error !== b.error ||
    a.tools.length !== b.tools.length ||
    a.connectNudges.length !== b.connectNudges.length ||
    a.subAgents.length !== b.subAgents.length ||
    a.narration.length !== b.narration.length
  ) {
    return false;
  }

  for (let i = 0; i < a.connectNudges.length; i += 1) {
    const left = a.connectNudges[i]!;
    const right = b.connectNudges[i]!;

    if (left.integration !== right.integration || left.action !== right.action) return false;
  }

  for (let i = 0; i < a.subAgents.length; i += 1) {
    const left = a.subAgents[i]!;
    const right = b.subAgents[i]!;

    if (
      left.parentToolCallId !== right.parentToolCallId ||
      left.outcome !== right.outcome ||
      left.waiting !== right.waiting ||
      left.endedTs !== right.endedTs ||
      !toolListsEqual(left.tools, right.tools)
    ) {
      return false;
    }
  }

  for (let i = 0; i < a.narration.length; i += 1) {
    const left = a.narration[i]!;
    const right = b.narration[i]!;

    if (left.index !== right.index || left.text !== right.text) return false;
  }

  return toolListsEqual(a.tools, b.tools);
}

/** Skips `startedTs` (write-once) and `endedTs` (changes with `status`). */
function toolListsEqual(a: StreamingToolCall[], b: StreamingToolCall[]): boolean {
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;

    if (
      left.toolCallId !== right.toolCallId ||
      left.toolName !== right.toolName ||
      left.status !== right.status ||
      left.argsPreview !== right.argsPreview ||
      left.resultPreview !== right.resultPreview ||
      left.resultTruncated !== right.resultTruncated ||
      left.sanitized !== right.sanitized ||
      left.segmentIndex !== right.segmentIndex
    ) {
      return false;
    }
  }

  return true;
}
