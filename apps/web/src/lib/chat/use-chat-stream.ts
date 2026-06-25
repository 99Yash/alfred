import type { EventPayload } from "@alfred/schemas/events";
import { useCallback, useEffect, useRef, useState } from "react";
import { openEventStream, type EventStreamFrame } from "~/lib/events/stream";
import { markChatTimingByAssistant } from "./timing";

export interface StreamingToolCall {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string;
  resultPreview?: string;
  /** ADR-0070: non-text bytes were stripped from this result before storage. */
  sanitized?: boolean;
  /** Narration segment this call follows — orders it against the narration trail. */
  segmentIndex: number;
}

/** A closed narration segment streamed before a tool step (interleaved in the trail). */
export interface StreamingNarration {
  index: number;
  text: string;
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
  narration: StreamingNarration[];
  /** Drip-buffered reasoning — the model's thinking, shown in the accordion. */
  reasoning: string;
  /** True while thinking is still arriving (reply hasn't started) — drives the shimmer. */
  reasoningActive: boolean;
  /** Frozen once thinking ends, in ms — drives the "Thought for Ns" label. */
  reasoningMs: number | null;
  tools: StreamingToolCall[];
  /** A write action is parked awaiting the user's approval. */
  awaitingApproval: boolean;
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
  awaitingApproval: boolean;
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
        const narration: StreamingNarration[] = [];
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
          awaitingApproval: r.awaitingApproval,
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
        awaitingApproval: false,
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
      // Freeze the current segment at what's shown so the bubble stops typing.
      const answer = r.segments.get(r.currentSegment) ?? "";
      r.segments.set(r.currentSegment, answer.slice(0, r.shown));
      r.reasoning = r.reasoning.slice(0, r.reasoningShown);
      ensureRaf();
    };

    const onFrame = (frame: EventStreamFrame) => {
      if (frame.kind === "chat.message") {
        const p = frame.payload as EventPayload<"chat.message">;
        if (p.threadId !== threadId) return;
        if (p.phase === "started") {
          ensureStreamRef(p.messageId, p.runId);
          markChatTimingByAssistant(p.messageId, "stream_started_event", undefined, {
            threadId,
            runId: p.runId,
          });
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
          ensureRaf();
        }
      } else if (frame.kind === "chat.reasoning") {
        const p = frame.payload as EventPayload<"chat.reasoning">;
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
        const p = frame.payload as EventPayload<"chat.delta">;
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
        const p = frame.payload as EventPayload<"chat.tool">;
        if (p.threadId !== threadId) return;
        const r = ensureStreamRef(p.messageId, p.runId);
        if (r.stopped) return;
        const prev = r.tools.get(p.toolCallId);
        r.tools.set(p.toolCallId, {
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          status: p.status,
          argsPreview: p.argsPreview ?? prev?.argsPreview,
          resultPreview: p.resultPreview ?? prev?.resultPreview,
          sanitized: p.sanitized ?? prev?.sanitized,
          segmentIndex: p.segmentIndex ?? prev?.segmentIndex ?? 0,
        });
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
      } else if (frame.kind === "approval.requested") {
        const p = frame.payload as EventPayload<"approval.requested">;
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
    a.done !== b.done ||
    a.tools.length !== b.tools.length ||
    a.narration.length !== b.narration.length
  ) {
    return false;
  }
  for (let i = 0; i < a.narration.length; i += 1) {
    const left = a.narration[i]!;
    const right = b.narration[i]!;
    if (left.index !== right.index || left.text !== right.text) return false;
  }
  for (let i = 0; i < a.tools.length; i += 1) {
    const left = a.tools[i]!;
    const right = b.tools[i]!;
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
