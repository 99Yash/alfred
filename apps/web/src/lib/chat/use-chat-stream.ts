import type { EventPayload } from "@alfred/contracts/events";
import type { SyncedChatNarration } from "@alfred/sync";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EventStreamFrame } from "~/lib/events/frame";
import { openEventStream } from "~/lib/events/stream";
import { markChatTimingByAssistant } from "./timing";

export interface StreamingToolCall {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string | undefined;
  resultPreview?: string | undefined;
  /** ADR-0070: non-text bytes were stripped from this result before storage. */
  sanitized?: boolean | undefined;
  /** Narration segment this call follows, ordering it against the narration trail. */
  segmentIndex: number;
  /**
   * Client clock at the first event seen for this call, and at its terminal
   * event (null while in flight) — the duration chip on the card. Measured at
   * event *receipt*, not on the server: it is honest about what the user
   * watched elapse, which is the only thing the chip claims.
   */
  startedTs: number;
  endedTs: number | null;
}

/** A spawned sub-agent's own tool calls, nested under the spawn card. */
export interface SubAgentTrail {
  /** The parent's `system.spawn_sub_agent` call this nests under. */
  parentToolCallId: string;
  subId: string;
  childRunId: string;
  tools: StreamingToolCall[];
  startedTs: number;
  endedTs: number | null;
  /** Terminal outcome once the child run reports one; null while running. */
  outcome: "completed" | "failed" | "cancelled" | null;
  /**
   * The child parked — it is waiting on the user (an approval) or on a signal,
   * not working. Non-terminal: the run is still live and will reach a real
   * `outcome`. The clock keeps running (the wait is honestly part of the wall
   * time); what this corrects is the *state*, so the card stops claiming the
   * child is busy while it is actually blocked on a human.
   */
  waiting: boolean;
}

/**
 * Whether a sub-agent's `chat.tool` event belongs to the turn currently on
 * screen. It must be able to *address* the in-flight turn but never *create*
 * one: a child outlives its parent turn (cancelling a run does not cascade to
 * its children, and a spawn need never be awaited), so a late child event can
 * arrive while a completely different turn is streaming. Mounting a fresh
 * stream ref for it would blank that turn's bubble and reset its delta seq.
 */
export function subAgentEventAddressesStream<
  T extends { messageId: string; runId: string; stopped: boolean },
>(current: T | null, event: { messageId: string; runId: string }): current is T {
  if (!current || current.stopped) return false;
  return current.messageId === event.messageId && current.runId === event.runId;
}

interface SubAgentTrailRef extends Omit<SubAgentTrail, "tools"> {
  tools: Map<string, StreamingToolCall>;
}

export function applyStreamingToolEvent(
  tools: Map<string, StreamingToolCall>,
  event: EventPayload<"chat.tool">,
  now: number = Date.now(),
): void {
  if (event.nonExecution) {
    tools.delete(event.toolCallId);
    return;
  }

  const previous = tools.get(event.toolCallId);
  // A terminal card is absorbing. `started` can arrive *after* it — the same
  // batch is re-dispatched on resume/reclaim and republishes its `started`, and
  // SSE frames are not ordered — and un-freezing the card would restart the
  // clock and flip a finished step back to a spinner.
  if (event.status === "started" && previous && previous.endedTs !== null) return;
  tools.set(event.toolCallId, {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    status: event.status,
    argsPreview: event.argsPreview ?? previous?.argsPreview,
    resultPreview: event.resultPreview ?? previous?.resultPreview,
    sanitized: event.sanitized ?? previous?.sanitized,
    segmentIndex: event.segmentIndex ?? previous?.segmentIndex ?? 0,
    startedTs: previous?.startedTs ?? now,
    // A terminal event freezes the clock; a repeated terminal event (replay)
    // keeps the first one so the chip doesn't drift upward on reconnect.
    endedTs: event.status === "started" ? null : (previous?.endedTs ?? now),
  });
}

export interface StreamingMessage {
  messageId: string;
  runId: string;
  /**
   * Drip-buffered text of the current (latest) segment — the live reply,
   * eased toward the full received text for smooth typing. Closed narration
   * segments move into `narration` as later segments begin.
   */
  text: string;
  /** Closed narration segments to interleave with the tool cards in the trail. */
  narration: SyncedChatNarration[];
  /** Drip-buffered reasoning — the model's thinking, shown in the accordion. */
  reasoning: string;
  /** True while thinking is still arriving (reply hasn't started) — drives the shimmer. */
  reasoningActive: boolean;
  /** Frozen once thinking ends, in ms — drives the "Thought for Ns" label. */
  reasoningMs: number | null;
  tools: StreamingToolCall[];
  /**
   * Live trails for sub-agents spawned this turn, keyed for the client by the
   * `spawn_sub_agent` call they nest under. Separate from `tools` so a child's
   * steps never flatten into the boss's own trail.
   */
  subAgents: SubAgentTrail[];
  /** A write action is parked awaiting the user's approval. */
  awaitingApproval: boolean;
  /** Context is being condensed before the next provider call. */
  compacting: boolean;
  /** The turn finished; the durable synced message will replace this shortly. */
  done: boolean;
}

interface StreamRef {
  messageId: string;
  runId: string;
  /** Received text per narration segment (full, pre-easing). */
  segments: Map<number, string>;
  /** Highest segment index seen — the current/answer segment. */
  currentSegment: number;
  /** Eased chars shown for the current segment; reset when the segment advances. */
  shown: number;
  /** Segment `shown` is counting against — guards the reset on segment change. */
  shownSegment: number;
  reasoning: string;
  reasoningShown: number;
  reasoningStartTs: number | null;
  reasoningMs: number | null;
  /** Reply text has begun — thinking for the final answer is over. */
  replyStarted: boolean;
  /** Last appended server seq for reply text; guards against replay duplicates. */
  deltaSeq: number;
  /** Last appended server seq for reasoning text; guards against replay duplicates. */
  reasoningSeq: number;
  tools: Map<string, StreamingToolCall>;
  /** Keyed by the parent's `spawn_sub_agent` toolCallId — one trail per child. */
  subAgents: Map<string, SubAgentTrailRef>;
  /**
   * childRunId → parentToolCallId, so an `agent.run` lifecycle frame (which
   * carries only the child's run id) can close the right trail.
   */
  subAgentRuns: Map<string, string>;
  awaitingApproval: boolean;
  compacting: boolean;
  done: boolean;
  /**
   * The user hit stop locally. We flip to done immediately and ignore any late
   * SSE frames for this run, so the bubble freezes the instant they click
   * instead of waiting on the worker's Redis-flag poll (~400ms) to round-trip a
   * `completed` event. The durable synced message still reconciles afterward.
   */
  stopped: boolean;
}

export interface ChatStream {
  /** The in-flight assistant turn, or null when nothing is streaming. */
  stream: StreamingMessage | null;
  /**
   * Optimistically stop the in-flight turn: freeze the partial reply at what's
   * shown and flip the composer back to its idle state right away. Pair with
   * the server-side stop request — this just makes the UI instant.
   */
  stopStream: () => void;
}

interface StreamSnapshot {
  threadId: string;
  message: StreamingMessage;
}

/**
 * Assembles the in-flight assistant turn for `threadId` from the SSE event bus.
 * `chat.delta` text and `chat.reasoning` thinking are each buffered and eased
 * out a few chars per animation frame (the drip buffer) so bursty server
 * flushes render as smooth typing; `chat.tool` events become live cards;
 * `approval.requested` flips the awaiting-approval flag. Returns null when
 * nothing is streaming.
 *
 * The streamed message is ephemeral — once the durable copy syncs via
 * Replicache (same messageId), the conversation view drops this bubble.
 */
export function useChatStream(threadId: string | undefined): ChatStream {
  const [snapshot, setSnapshot] = useState<StreamSnapshot | null>(null);
  const ref = useRef<StreamRef | null>(null);
  const lastSnapshotRef = useRef<StreamingMessage | null>(null);
  const rafRef = useRef<number | null>(null);
  // The effect installs the real stopper once the SSE stream is open; the
  // returned `stopStream` is a stable proxy so consumers don't re-bind.
  const stopFnRef = useRef<(() => void) | null>(null);
  const stopStream = useCallback(() => stopFnRef.current?.(), []);

  useEffect(() => {
    ref.current = null;
    lastSnapshotRef.current = null;
    if (!threadId) return;

    const ensureRaf = () => {
      if (rafRef.current !== null) return;
      const tick = () => {
        const r = ref.current;
        if (!r) {
          rafRef.current = null;
          return;
        }
        const ease = (shown: number, full: number) =>
          shown < full ? Math.min(full, shown + Math.max(2, Math.ceil((full - shown) / 8))) : shown;
        // The current segment is the live reply; when it advances, restart the
        // typing counter so the new segment eases in from the start (the prior
        // segment has by then moved into the narration trail).
        if (r.shownSegment !== r.currentSegment) {
          r.shownSegment = r.currentSegment;
          r.shown = 0;
        }
        const answer = r.segments.get(r.currentSegment) ?? "";
        r.reasoningShown = ease(r.reasoningShown, r.reasoning.length);
        r.shown = ease(r.shown, answer.length);
        const narration: SyncedChatNarration[] = [];
        for (const [index, text] of r.segments) {
          if (index < r.currentSegment && text.trim().length > 0) narration.push({ index, text });
        }
        narration.sort((a, b) => a.index - b.index);
        const nextSnapshot: StreamingMessage = {
          messageId: r.messageId,
          runId: r.runId,
          text: answer.slice(0, r.shown),
          narration,
          reasoning: r.reasoning.slice(0, r.reasoningShown),
          reasoningActive: r.reasoning.length > 0 && !r.replyStarted && !r.done,
          reasoningMs: r.reasoningMs,
          tools: [...r.tools.values()],
          subAgents: [...r.subAgents.values()].map((trail) => ({
            ...trail,
            tools: [...trail.tools.values()],
          })),
          awaitingApproval: r.awaitingApproval,
          compacting: r.compacting,
          done: r.done,
        };
        if (!streamSnapshotsEqual(lastSnapshotRef.current, nextSnapshot)) {
          lastSnapshotRef.current = nextSnapshot;
          setSnapshot({ threadId, message: nextSnapshot });
        }
        // Keep ticking only while the eased buffers are catching up. Future
        // SSE frames call `ensureRaf()` again, including approval/completed
        // state changes, so an approval wait does not spin at 60fps.
        const caughtUp = r.shown >= answer.length && r.reasoningShown >= r.reasoning.length;
        if (!caughtUp) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          rafRef.current = null;
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    /**
     * Return the in-flight stream state for `messageId`, creating it if needed.
     * The `chat.message` "started" event normally mounts this, but on a fresh
     * thread the navigation `/chat` → `/chat/<id>` reopens the SSE stream and
     * "started" can fire in that gap (the bus has no replay). Initializing from
     * the first event of any kind — reasoning, delta, or tool — keeps the turn
     * from rendering blank when "started" is missed. A different `messageId`
     * or `runId` means a new turn, so we reset.
     */
    const ensureStreamRef = (messageId: string, runId: string): StreamRef => {
      const existing = ref.current;
      if (existing && existing.messageId === messageId && existing.runId === runId) return existing;
      const fresh: StreamRef = {
        messageId,
        runId,
        segments: new Map(),
        currentSegment: 0,
        shown: 0,
        shownSegment: 0,
        reasoning: "",
        reasoningShown: 0,
        reasoningStartTs: null,
        reasoningMs: null,
        replyStarted: false,
        deltaSeq: 0,
        reasoningSeq: 0,
        tools: new Map(),
        subAgents: new Map(),
        subAgentRuns: new Map(),
        awaitingApproval: false,
        compacting: false,
        done: false,
        stopped: false,
      };
      ref.current = fresh;
      return fresh;
    };

    // Optimistic stop: freeze the eased buffers at what's currently shown and
    // flip to done so the composer swaps back to the send button this frame.
    // `stopped` makes onFrame drop any further deltas for this run, so the
    // bubble doesn't keep typing while the server finalizes in the background.
    stopFnRef.current = () => {
      const r = ref.current;
      if (!r || r.stopped) return;
      r.stopped = true;
      r.done = true;
      r.awaitingApproval = false;
      r.compacting = false;
      // Freeze the current segment at what's shown so the bubble stops typing.
      const answer = r.segments.get(r.currentSegment) ?? "";
      r.segments.set(r.currentSegment, answer.slice(0, r.shown));
      r.reasoning = r.reasoning.slice(0, r.reasoningShown);
      ensureRaf();
    };

    const onFrame = (frame: EventStreamFrame) => {
      if (frame.kind === "chat.message") {
        const p = frame.payload;
        if (p.threadId !== threadId) return;
        if (p.phase === "started") {
          ensureStreamRef(p.messageId, p.runId);
          markChatTimingByAssistant(p.messageId, "stream_started_event", undefined, {
            threadId,
            runId: p.runId,
          });
          ensureRaf();
        } else if (
          (p.phase === "compaction_started" || p.phase === "compaction_finished") &&
          ref.current?.messageId === p.messageId &&
          ref.current.runId === p.runId
        ) {
          ref.current.compacting = p.phase === "compaction_started";
          ensureRaf();
        } else if (
          p.phase === "completed" &&
          ref.current?.messageId === p.messageId &&
          ref.current.runId === p.runId
        ) {
          markChatTimingByAssistant(p.messageId, "completion_event", undefined, {
            threadId,
            runId: p.runId,
            summarize: true,
          });
          ref.current.done = true;
          ref.current.awaitingApproval = false;
          ref.current.compacting = false;
          ensureRaf();
        }
      } else if (frame.kind === "chat.reasoning") {
        const p = frame.payload;
        if (p.threadId !== threadId) return;
        const r = ensureStreamRef(p.messageId, p.runId);
        if (r.stopped) return;
        if (p.seq <= r.reasoningSeq) return;
        r.reasoningSeq = p.seq;
        if (r.reasoningStartTs === null) r.reasoningStartTs = Date.now();
        r.reasoning += p.text;
        markChatTimingByAssistant(
          p.messageId,
          "first_reasoning_frame",
          { seq: p.seq, chars: p.text.length, totalReasoningChars: r.reasoning.length },
          { threadId, runId: p.runId },
        );
        markChatTimingByAssistant(
          p.messageId,
          "last_reasoning_frame",
          { seq: p.seq, chars: p.text.length, totalReasoningChars: r.reasoning.length },
          { threadId, runId: p.runId, repeat: "update", log: false },
        );
        ensureRaf();
      } else if (frame.kind === "chat.delta") {
        const p = frame.payload;
        if (p.threadId !== threadId) return;
        const r = ensureStreamRef(p.messageId, p.runId);
        if (r.stopped) return;
        if (p.seq <= r.deltaSeq) return;
        r.deltaSeq = p.seq;
        // First reply token: thinking for the answer is over — freeze its duration.
        if (!r.replyStarted) {
          r.replyStarted = true;
          if (r.reasoningStartTs !== null && r.reasoningMs === null) {
            r.reasoningMs = Date.now() - r.reasoningStartTs;
          }
        }
        // Append to this delta's segment. A higher segment means the prior
        // segment just closed (the model wrote it before a tool step) — it
        // drops into the narration trail and this becomes the live reply.
        const segment = p.segmentIndex ?? 0;
        r.segments.set(segment, (r.segments.get(segment) ?? "") + p.text);
        if (segment > r.currentSegment) r.currentSegment = segment;
        markChatTimingByAssistant(
          p.messageId,
          "first_delta_frame",
          {
            seq: p.seq,
            chars: p.text.length,
            totalTextChars: r.segments.get(segment)?.length ?? 0,
          },
          { threadId, runId: p.runId },
        );
        markChatTimingByAssistant(
          p.messageId,
          "last_delta_frame",
          {
            seq: p.seq,
            chars: p.text.length,
            totalTextChars: r.segments.get(segment)?.length ?? 0,
          },
          { threadId, runId: p.runId, repeat: "update", log: false },
        );
        ensureRaf();
      } else if (frame.kind === "chat.tool") {
        const p = frame.payload;
        if (p.threadId !== threadId) return;
        // A spawned sub-agent's call nests under the `spawn_sub_agent` card that
        // started it rather than joining the boss's own trail. The event
        // deliberately carries the parent's runId/messageId (see
        // `chatToolSubAgentSchema`) — but it resolves against the turn already
        // on screen and never mounts one, because a child can outlive its
        // parent turn and must not hijack whatever is streaming now.
        if (p.subAgent) {
          const current = ref.current;
          if (!subAgentEventAddressesStream(current, p)) return;
          const { parentToolCallId, subId, childRunId } = p.subAgent;
          const existing = current.subAgents.get(parentToolCallId);
          // A bounce retracts a card; with no trail there is nothing to retract,
          // and drawing an empty container for it would be worse than silence.
          if (!existing && p.nonExecution) return;
          const trail = existing ?? {
            parentToolCallId,
            subId,
            childRunId,
            tools: new Map<string, StreamingToolCall>(),
            startedTs: Date.now(),
            endedTs: null,
            outcome: null,
            waiting: false,
          };
          applyStreamingToolEvent(trail.tools, p);
          current.subAgents.set(parentToolCallId, trail);
          current.subAgentRuns.set(childRunId, parentToolCallId);
          ensureRaf();
          return;
        }
        const r = ensureStreamRef(p.messageId, p.runId);
        if (r.stopped) return;
        applyStreamingToolEvent(r.tools, p);
        if (p.nonExecution) {
          ensureRaf();
          return;
        }
        markChatTimingByAssistant(
          p.messageId,
          "first_tool_event",
          { toolName: p.toolName, status: p.status },
          { threadId, runId: p.runId },
        );
        markChatTimingByAssistant(
          p.messageId,
          "last_tool_event",
          { toolName: p.toolName, status: p.status },
          { threadId, runId: p.runId, repeat: "update", log: false },
        );
        ensureRaf();
      } else if (frame.kind === "agent.run") {
        // A child run's own lifecycle. `chat.tool` says what a sub-agent did but
        // never that it is finished or that it stalled, so both come from here —
        // the executor already publishes these for every run, children included.
        // Frames for the parent run and for unrelated background runs fall
        // through: only a runId we mapped from a child's tool event reaches a
        // trail.
        const p = frame.payload;
        const r = ref.current;
        if (!r || r.stopped) return;
        const parentToolCallId = r.subAgentRuns.get(p.runId);
        if (!parentToolCallId) return;
        const trail = r.subAgents.get(parentToolCallId);
        // Terminal is absorbing: a later frame for a landed child changes nothing.
        if (!trail || trail.outcome !== null) return;
        if (p.phase === "completed" || p.phase === "failed" || p.phase === "cancelled") {
          trail.outcome = p.phase;
          trail.endedTs = Date.now();
          trail.waiting = false;
        } else if (p.phase === "interrupted") {
          // The child parked — most often on an approval, so the time from here
          // is the user's, not the agent's. The card stops claiming it is busy.
          trail.waiting = true;
        } else if (trail.waiting) {
          // Any other frame from a parked child means it is moving again. Note
          // `resumed` is in the enum but nothing publishes it: a resuming run
          // emits `step_started`, so this clears on activity rather than on a
          // phase name.
          trail.waiting = false;
        } else {
          return;
        }
        ensureRaf();
      } else if (frame.kind === "approval.requested") {
        const p = frame.payload;
        const r = ref.current;
        if (!r || r.stopped || p.runId !== r.runId) return;
        r.awaitingApproval = true;
        markChatTimingByAssistant(
          r.messageId,
          "approval_requested",
          { approvalId: p.approvalId },
          { threadId, runId: r.runId },
        );
        ensureRaf();
      }
    };

    const close = openEventStream({ onFrame });
    return () => {
      close();
      stopFnRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [threadId]);

  const stream = snapshot && snapshot.threadId === threadId ? snapshot.message : null;
  return { stream, stopStream };
}

function streamSnapshotsEqual(a: StreamingMessage | null, b: StreamingMessage): boolean {
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
    a.done !== b.done ||
    a.tools.length !== b.tools.length ||
    a.subAgents.length !== b.subAgents.length ||
    a.narration.length !== b.narration.length
  ) {
    return false;
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

/**
 * Field-wise comparison of two tool lists. `startedTs` is deliberately excluded
 * — it is assigned once on first sight and never changes, so comparing it would
 * only cost cycles; `endedTs` moves exactly once (with `status`) and is covered
 * by the status check.
 */
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
      left.sanitized !== right.sanitized ||
      left.segmentIndex !== right.segmentIndex
    ) {
      return false;
    }
  }
  return true;
}
