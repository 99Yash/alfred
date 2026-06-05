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
  tools: Map<string, StreamingToolCall>;
  awaitingApproval: boolean;
  done: boolean;
}

/**
 * Assembles the in-flight assistant turn for `threadId` from the SSE event bus.
 * `chat.delta` text is buffered and eased out a few chars per animation frame
 * (the drip buffer) so bursty server flushes render as smooth typing;
 * `chat.tool` events become live cards; `approval.requested` flips the
 * awaiting-approval flag. Returns null when nothing is streaming.
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
        if (r.shown < r.target.length) {
          const remaining = r.target.length - r.shown;
          r.shown += Math.max(2, Math.ceil(remaining / 8));
          if (r.shown > r.target.length) r.shown = r.target.length;
        }
        setSnapshot({
          messageId: r.messageId,
          runId: r.runId,
          text: r.target.slice(0, r.shown),
          tools: [...r.tools.values()],
          awaitingApproval: r.awaitingApproval,
          done: r.done,
        });
        // Keep ticking until the text has fully caught up. Once done + caught
        // up, stop — the snapshot stays put until the synced message lands.
        if (!r.done || r.shown < r.target.length) {
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
      } else if (frame.kind === "chat.delta") {
        const p = frame.payload as EventPayload<"chat.delta">;
        const r = ref.current;
        if (!r || p.threadId !== threadId || p.messageId !== r.messageId) return;
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
