import type { EventPayload } from "@alfred/schemas/events";
import { useEffect, useRef, useState } from "react";
import { openEventStream, type EventStreamFrame } from "~/lib/events/stream";

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
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    ref.current = null;
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
        setSnapshot({
          messageId: r.messageId,
          runId: r.runId,
          text: r.target.slice(0, r.shown),
          reasoning: r.reasoning.slice(0, r.reasoningShown),
          reasoningActive: r.reasoning.length > 0 && !r.replyStarted && !r.done,
          reasoningMs: r.reasoningMs,
          tools: [...r.tools.values()],
          awaitingApproval: r.awaitingApproval,
          done: r.done,
        });
        // Keep ticking until both tracks have fully caught up. Once done +
        // caught up, stop — the snapshot stays put until the synced message lands.
        const caughtUp = r.shown >= r.target.length && r.reasoningShown >= r.reasoning.length;
        if (!r.done || !caughtUp) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          rafRef.current = null;
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    const onFrame = (frame: EventStreamFrame) => {
      if (frame.kind === "chat.message") {
        const p = frame.payload as EventPayload<"chat.message">;
        if (p.threadId !== threadId) return;
        if (p.phase === "started") {
          ref.current = {
            messageId: p.messageId,
            runId: p.runId,
            target: "",
            shown: 0,
            reasoning: "",
            reasoningShown: 0,
            reasoningStartTs: null,
            reasoningMs: null,
            replyStarted: false,
            tools: new Map(),
            awaitingApproval: false,
            done: false,
          };
          ensureRaf();
        } else if (p.phase === "completed" && ref.current?.messageId === p.messageId) {
          ref.current.done = true;
          ref.current.awaitingApproval = false;
          ensureRaf();
        }
      } else if (frame.kind === "chat.reasoning") {
        const p = frame.payload as EventPayload<"chat.reasoning">;
        const r = ref.current;
        if (!r || p.threadId !== threadId || p.messageId !== r.messageId) return;
        if (r.reasoningStartTs === null) r.reasoningStartTs = Date.now();
        r.reasoning += p.text;
        ensureRaf();
      } else if (frame.kind === "chat.delta") {
        const p = frame.payload as EventPayload<"chat.delta">;
        const r = ref.current;
        if (!r || p.threadId !== threadId || p.messageId !== r.messageId) return;
        // First reply token: thinking for the answer is over — freeze its duration.
        if (!r.replyStarted) {
          r.replyStarted = true;
          if (r.reasoningStartTs !== null && r.reasoningMs === null) {
            r.reasoningMs = Date.now() - r.reasoningStartTs;
          }
        }
        r.target += p.text;
        ensureRaf();
      } else if (frame.kind === "chat.tool") {
        const p = frame.payload as EventPayload<"chat.tool">;
        const r = ref.current;
        if (!r || p.threadId !== threadId || p.messageId !== r.messageId) return;
        const prev = r.tools.get(p.toolCallId);
        r.tools.set(p.toolCallId, {
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          status: p.status,
          argsPreview: p.argsPreview ?? prev?.argsPreview,
          resultPreview: p.resultPreview ?? prev?.resultPreview,
        });
        ensureRaf();
      } else if (frame.kind === "approval.requested") {
        const p = frame.payload as EventPayload<"approval.requested">;
        const r = ref.current;
        if (!r || p.runId !== r.runId) return;
        r.awaitingApproval = true;
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
