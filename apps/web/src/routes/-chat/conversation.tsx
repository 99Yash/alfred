import type { SyncedChatMessage } from "@alfred/sync";
import { Loader2, ShieldQuestion } from "lucide-react";
import { useEffect, useRef } from "react";
import type { StreamingMessage } from "~/lib/chat/use-chat-stream";
import { AssistantMarkdown, MessageBubble } from "./message-bubble";
import { ReasoningSection } from "./reasoning-section";
import { ToolCallCard } from "./tool-call-card";

export function shouldShowStream(
  messages: readonly SyncedChatMessage[],
  stream: StreamingMessage | null,
): stream is StreamingMessage {
  return stream !== null && !messages.some((m) => m.id === stream.messageId);
}

/**
 * Scrollable message feed. Renders the synced (durable) messages, then — if a
 * turn is mid-flight and its durable copy hasn't synced yet — the live
 * streaming bubble. Auto-sticks to the bottom as content grows unless the
 * user has scrolled up to read history.
 */
export function Conversation({
  messages,
  stream,
}: {
  messages: SyncedChatMessage[];
  stream: StreamingMessage | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const showStream = shouldShowStream(messages, stream);

  // Track whether the user is parked at the bottom; only auto-scroll if so.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Re-stick to the bottom when the feed grows. `stream` is a fresh snapshot
  // each animation frame while a turn is in flight, so this fires per drip
  // tick during streaming and on each new durable message — but not on
  // unrelated re-renders (which a depless effect would).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, stream]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {showStream && stream ? (
          <div className="flex flex-col gap-2">
            {stream.reasoning.length > 0 || stream.reasoningActive ? (
              <ReasoningSection
                reasoning={stream.reasoning}
                active={stream.reasoningActive}
                durationMs={stream.reasoningMs}
              />
            ) : null}

            {stream.tools.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                {stream.tools.map((t) => (
                  <ToolCallCard key={t.toolCallId} tool={t} />
                ))}
              </div>
            ) : null}

            {stream.text.length > 0 ? (
              <AssistantMarkdown text={stream.text} streaming={!stream.done} />
            ) : stream.tools.length === 0 &&
              stream.reasoning.length === 0 &&
              !stream.reasoningActive ? (
              <ThinkingIndicator />
            ) : null}

            {stream.awaitingApproval ? <ApprovalNotice /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-[14px] text-vs-fg-3">
      <Loader2 size={14} className="animate-spin" />
      <span className="animate-chat-shimmer">Thinking…</span>
    </div>
  );
}

/**
 * A write action is parked awaiting approval. The full confirm/deny surface
 * lives in the approvals rail; this inline notice points there. (Inline
 * approve/deny is a follow-up — see the streaming-chat plan.)
 */
function ApprovalNotice() {
  return (
    <div className="animate-chat-in flex items-center gap-2 rounded-xl border border-vs-amber-2/60 bg-vs-amber-1/40 px-3 py-2 text-[13px] text-vs-fg-4">
      <ShieldQuestion size={14} className="shrink-0 text-vs-amber-4" />
      <span>Waiting for your approval to take this action — review it in Approvals.</span>
    </div>
  );
}
