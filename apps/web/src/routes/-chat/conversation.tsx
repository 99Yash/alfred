import type { SyncedChatMessage } from "@alfred/sync";
import { Loader2, ShieldQuestion } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";
import { markChatTimingByAssistant } from "~/lib/chat/timing";
import type { StreamingMessage } from "~/lib/chat/use-chat-stream";
import { IntegrationGlyph } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { shouldShowStream, type FollowUpSuggestion } from "./conversation-helpers";
import { AssistantMarkdown, MessageBubble } from "./message-bubble";
import { ReasoningSection } from "./reasoning-section";
import { SourcesStrip } from "./sources-strip";
import { collectSources } from "./sources";
import { ToolCallGroup } from "./tool-call-group";

/**
 * Scrollable message feed. Renders the synced (durable) messages, then — if a
 * turn is mid-flight and its durable copy hasn't synced yet — the live
 * streaming bubble. Auto-sticks to the bottom as content grows unless the
 * user has scrolled up to read history.
 */
export function Conversation({
  messages,
  stream,
  onFollowUp,
  followUps = EMPTY_FOLLOW_UPS,
}: {
  messages: SyncedChatMessage[];
  stream: StreamingMessage | null;
  onFollowUp?: (text: string) => void;
  /** Follow-up chips rendered under the last completed reply (built by the parent). */
  followUps?: ReadonlyArray<FollowUpSuggestion>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const showStream = shouldShowStream(messages, stream);

  // ---- Follow the live edge -------------------------------------------
  // While a turn is in flight the viewport rides the bottom so the newest
  // activity — reasoning, the tool group's current step, the reply text —
  // stays in view without the user touching the scrollbar. Scrolling up to
  // read history detaches it (see `onScroll`); sending a new message
  // re-engages it so the next turn follows from the start.
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "user") return m.id;
    }
    return null;
  }, [messages]);
  const seenUserIdRef = useRef<string | null>(null);
  if (lastUserId !== seenUserIdRef.current) {
    seenUserIdRef.current = lastUserId;
    stickRef.current = true;
  }

  // Detach the moment the user scrolls up; re-attach once they return to the
  // bottom (within 80px). Programmatic scroll-to-bottom below also fires this,
  // which simply re-confirms the attached state.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Re-stick to the bottom whenever the feed grows. `stream` is a fresh
  // snapshot each drip tick while a turn is in flight, so this fires per frame
  // during streaming and on each new durable message — but not on unrelated
  // re-renders (which a depless effect would).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, stream]);

  const streamTimingRefs = useStreamRenderTiming(showStream ? stream : null);

  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      markChatTimingByAssistant(
        message.id,
        "persisted_assistant_rendered",
        {
          status: message.status,
          chars: message.content.length,
          reasoningChars: message.reasoning?.length ?? 0,
        },
        { requireExisting: true, summarize: true },
      );
    }
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto scroll-stable"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {onFollowUp && followUps.length > 0 ? (
          <FollowUpSuggestions suggestions={followUps} onPick={onFollowUp} />
        ) : null}

        {showStream && stream ? (
          <div key={`${stream.messageId}:${stream.runId}`} className="flex flex-col gap-2">
            {stream.reasoning.length > 0 || stream.reasoningActive ? (
              <div ref={stream.reasoning.length > 0 ? streamTimingRefs.reasoning : undefined}>
                <ReasoningSection
                  reasoning={stream.reasoning}
                  active={stream.reasoningActive}
                  durationMs={stream.reasoningMs}
                />
              </div>
            ) : null}

            {stream.tools.length > 0 ? (
              <ToolCallGroup tools={stream.tools} active={!stream.done} />
            ) : null}

            {stream.text.length > 0 ? (
              <div ref={streamTimingRefs.text}>
                <AssistantMarkdown text={stream.text} streaming={!stream.done} />
              </div>
            ) : stream.tools.length === 0 &&
              stream.reasoning.length === 0 &&
              !stream.reasoningActive ? (
              <div ref={streamTimingRefs.thinking}>
                <ThinkingIndicator />
              </div>
            ) : null}

            {stream.done ? <SourcesStrip sources={collectSources(stream.tools)} /> : null}

            {stream.awaitingApproval ? <ApprovalNotice /> : null}
            {stream.done ? <span ref={streamTimingRefs.done} hidden /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const EMPTY_FOLLOW_UPS: ReadonlyArray<FollowUpSuggestion> = [];

function useStreamRenderTiming(stream: StreamingMessage | null): {
  thinking: (el: HTMLDivElement | null) => void;
  reasoning: (el: HTMLDivElement | null) => void;
  text: (el: HTMLDivElement | null) => void;
  done: (el: HTMLSpanElement | null) => void;
} {
  const thinking = useRefCallback((el: HTMLDivElement | null) => {
    if (!el || !stream) return;
    markChatTimingByAssistant(stream.messageId, "thinking_indicator_rendered", undefined, {
      requireExisting: true,
      runId: stream.runId,
    });
  });
  const reasoning = useRefCallback((el: HTMLDivElement | null) => {
    if (!el || !stream || stream.reasoning.length === 0) return;
    markChatTimingByAssistant(
      stream.messageId,
      "first_visible_reasoning_rendered",
      { visibleChars: stream.reasoning.length },
      { requireExisting: true, runId: stream.runId },
    );
  });
  const text = useRefCallback((el: HTMLDivElement | null) => {
    if (!el || !stream || stream.text.length === 0) return;
    markChatTimingByAssistant(
      stream.messageId,
      "first_visible_text_rendered",
      { visibleChars: stream.text.length },
      { requireExisting: true, runId: stream.runId },
    );
  });
  const done = useRefCallback((el: HTMLSpanElement | null) => {
    if (!el || !stream || !stream.done) return;
    markChatTimingByAssistant(
      stream.messageId,
      "stream_done_rendered",
      {
        visibleChars: stream.text.length,
        visibleReasoningChars: stream.reasoning.length,
      },
      { requireExisting: true, runId: stream.runId, summarize: true },
    );
  });
  return { thinking, reasoning, text, done };
}

function useRefCallback<T extends Element>(
  callback: (el: T | null) => void,
): (el: T | null) => void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useMemo(() => (el: T | null) => callbackRef.current(el), []);
}

/** True on Apple platforms — picks the ⌥ glyph over the "Alt+" prefix in kbd hints. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.userAgent);

function FollowUpSuggestions({
  suggestions,
  onPick,
}: {
  suggestions: readonly FollowUpSuggestion[];
  onPick: (text: string) => void;
}) {
  const onPickEvent = useEffectEvent(onPick);
  // ⌥1…⌥9 picks a chip from anywhere on the page. `e.code` (not `e.key`)
  // because Option+digit types a glyph ("¡", "™"…) on macOS keyboards.
  // Alt+digit is unreserved in every browser, unlike ⌘digit (tab switching).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const match = /^Digit([1-9])$/.exec(e.code);
      if (!match) return;
      const pick = suggestions[Number(match[1]) - 1];
      if (!pick) return;
      e.preventDefault();
      onPickEvent(pick.text);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [suggestions]);

  return (
    <div className="animate-chat-in flex flex-wrap gap-2 pt-1">
      {suggestions.map((suggestion, i) => (
        <button
          key={suggestion.id}
          type="button"
          onClick={() => onPick(suggestion.text)}
          className={cn(
            "inline-flex min-h-10 max-w-full items-center gap-2 rounded-full px-3 text-left",
            "bg-app-bg-2/70 text-[13px] font-medium leading-snug text-app-fg-3",
            "shadow-[inset_0_0_0_1px_var(--app-fg-a1)]",
            "transition-[background-color,color,transform,box-shadow] duration-150 ease-out",
            "hover:bg-app-bg-a2 hover:text-app-fg-4",
            "active:scale-[0.96]",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          )}
        >
          <IntegrationGlyph brand={suggestion.brand} size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{suggestion.text}</span>
          {i < 9 ? (
            <kbd
              className={cn(
                "shrink-0 inline-flex items-center justify-center h-[16px] px-1 rounded",
                "text-[10px] leading-none font-medium font-sans tabular-nums",
                "bg-app-bg-a2 text-app-fg-2",
              )}
            >
              {IS_MAC ? `⌥${i + 1}` : `Alt+${i + 1}`}
            </kbd>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-[14px] text-app-fg-3">
      <Loader2 size={14} className="animate-spin" />
      <span className="animate-chat-shimmer">Thinking…</span>
    </div>
  );
}

/** A run is parked awaiting approval; the full decision surface sits below the transcript. */
function ApprovalNotice() {
  return (
    <div className="animate-chat-in flex items-center gap-2 rounded-xl border border-app-amber-2/60 bg-app-amber-1/40 px-3 py-2 text-[13px] text-app-fg-4">
      <ShieldQuestion size={14} className="shrink-0 text-app-amber-4" />
      <span>Waiting for your approval to take this action, review it below.</span>
    </div>
  );
}
