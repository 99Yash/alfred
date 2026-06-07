import type { EventPayload } from "@alfred/schemas/events";
import { useEffect, useRef, useState } from "react";
import { openEventStream, type EventStreamFrame } from "~/lib/events/stream";
import { markChatTimingByAssistant } from "./timing";

export interface StreamingToolCall {
  toolCallId: string;
  toolName: string;
  status: "started" | "succeeded" | "failed";
  argsPreview?: string;
  resultPreview?: string;
}

export interface StreamingMessage {
  messageId: string;
  runId: string;
  /** Drip-buffered text — eases toward the full received text for smooth typing. */
  text: string;
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
  target: string;
  shown: number;
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
export function useChatStream(threadId: string | undefined): StreamingMessage | null {
  const [snapshot, setSnapshot] = useState<StreamingMessage | null>(null);
  const ref = useRef<StreamRef | null>(null);
  const lastSnapshotRef = useRef<StreamingMessage | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    ref.current = null;
    lastSnapshotRef.current = null;
    setSnapshot(null);
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
        r.reasoningShown = ease(r.reasoningShown, r.reasoning.length);
        r.shown = ease(r.shown, r.target.length);
        const nextSnapshot: StreamingMessage = {
          messageId: r.messageId,
          runId: r.runId,
          text: r.target.slice(0, r.shown),
          reasoning: r.reasoning.slice(0, r.reasoningShown),
          reasoningActive: r.reasoning.length > 0 && !r.replyStarted && !r.done,
          reasoningMs: r.reasoningMs,
          tools: [...r.tools.values()],
          awaitingApproval: r.awaitingApproval,
          done: r.done,
        };
        if (!streamSnapshotsEqual(lastSnapshotRef.current, nextSnapshot)) {
          lastSnapshotRef.current = nextSnapshot;
          setSnapshot(nextSnapshot);
        }
        // Keep ticking only while the eased buffers are catching up. Future
        // SSE frames call `ensureRaf()` again, including approval/completed
        // state changes, so an approval wait does not spin at 60fps.
        const caughtUp = r.shown >= r.target.length && r.reasoningShown >= r.reasoning.length;
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
        target: "",
        shown: 0,
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
      };
      ref.current = fresh;
      return fresh;
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
        if (p.seq <= r.deltaSeq) return;
        r.deltaSeq = p.seq;
        // First reply token: thinking for the answer is over — freeze its duration.
        if (!r.replyStarted) {
          r.replyStarted = true;
          if (r.reasoningStartTs !== null && r.reasoningMs === null) {
            r.reasoningMs = Date.now() - r.reasoningStartTs;
          }
        }
        r.target += p.text;
        markChatTimingByAssistant(
          p.messageId,
          "first_delta_frame",
          { seq: p.seq, chars: p.text.length, totalTextChars: r.target.length },
          { threadId, runId: p.runId },
        );
        markChatTimingByAssistant(
          p.messageId,
          "last_delta_frame",
          { seq: p.seq, chars: p.text.length, totalTextChars: r.target.length },
          { threadId, runId: p.runId, repeat: "update", log: false },
        );
        ensureRaf();
      } else if (frame.kind === "chat.tool") {
        const p = frame.payload as EventPayload<"chat.tool">;
        if (p.threadId !== threadId) return;
        const r = ensureStreamRef(p.messageId, p.runId);
        const prev = r.tools.get(p.toolCallId);
        r.tools.set(p.toolCallId, {
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          status: p.status,
          argsPreview: p.argsPreview ?? prev?.argsPreview,
          resultPreview: p.resultPreview ?? prev?.resultPreview,
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
        if (!r || p.runId !== r.runId) return;
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
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [threadId]);

  return snapshot;
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
    a.tools.length !== b.tools.length
  ) {
    return false;
  }
  for (let i = 0; i < a.tools.length; i += 1) {
    const left = a.tools[i]!;
    const right = b.tools[i]!;
    if (
      left.toolCallId !== right.toolCallId ||
      left.toolName !== right.toolName ||
      left.status !== right.status ||
      left.argsPreview !== right.argsPreview ||
      left.resultPreview !== right.resultPreview
    ) {
      return false;
    }
  }
  return true;
}
