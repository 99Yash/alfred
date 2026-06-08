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
import { ToolCallCard } from "./tool-call-card";

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

  // ---- Send-anchoring -------------------------------------------------
  // When the user sends a message, scroll it to the top of the viewport
  // (ChatGPT-style) so the reply streams downward from a stable read
  // position instead of chasing the tail. A spacer below the feed makes
  // room; it shrinks 1:1 as the reply grows, so the scroll position holds
  // without jumps. Scrolling (wheel/touch) disengages the anchor and hands
  // control back to the stick-to-bottom behavior below.
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "user") return m.id;
    }
    return null;
  }, [messages]);
  const userMsgElRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef(false);
  const seenUserIdRef = useRef<string | null>(null);
  if (lastUserId !== seenUserIdRef.current) {
    const isInitialLoad = seenUserIdRef.current === null && messages.length > 1;
    seenUserIdRef.current = lastUserId;
    if (!isInitialLoad && lastUserId !== null) anchorRef.current = true;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Stop pinning, but leave the spacer as-is — collapsing it here would
    // clamp scrollTop and visibly jump the feed. It re-sizes on the next
    // send and is harmless meanwhile (same trailing room ChatGPT keeps).
    const disengage = () => {
      anchorRef.current = false;
    };
    el.addEventListener("wheel", disengage, { passive: true });
    el.addEventListener("touchmove", disengage, { passive: true });
    return () => {
      el.removeEventListener("wheel", disengage);
      el.removeEventListener("touchmove", disengage);
    };
  }, []);

  // Track whether the user is parked at the bottom; only auto-scroll if so.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Re-stick to the bottom when the feed grows (unless send-anchored).
  // `stream` is a fresh snapshot each animation frame while a turn is in
  // flight, so this fires per drip tick during streaming and on each new
  // durable message — but not on unrelated re-renders (which a depless
  // effect would).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const userEl = userMsgElRef.current;
    const spacer = spacerRef.current;
    if (anchorRef.current && userEl && spacer) {
      const TOP_GAP = 24; // breathing room above the anchored message
      spacer.style.height = "0px";
      const userTop =
        userEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const needed = Math.max(0, userTop - TOP_GAP + el.clientHeight - el.scrollHeight);
      spacer.style.height = `${needed}px`;
      el.scrollTop = userTop - TOP_GAP;
    } else if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, stream]);

  useEffect(() => {
    if (!showStream || !stream) return;
    const base = { requireExisting: true, runId: stream.runId };
    if (
      stream.text.length === 0 &&
      stream.reasoning.length === 0 &&
      stream.tools.length === 0 &&
      !stream.awaitingApproval
    ) {
      markChatTimingByAssistant(stream.messageId, "thinking_indicator_rendered", undefined, base);
    }
    if (stream.reasoning.length > 0) {
      markChatTimingByAssistant(
        stream.messageId,
        "first_visible_reasoning_rendered",
        { visibleChars: stream.reasoning.length },
        base,
      );
    }
    if (stream.text.length > 0) {
      markChatTimingByAssistant(
        stream.messageId,
        "first_visible_text_rendered",
        { visibleChars: stream.text.length },
        base,
      );
    }
    if (stream.done) {
      markChatTimingByAssistant(
        stream.messageId,
        "stream_done_rendered",
        {
          visibleChars: stream.text.length,
          visibleReasoningChars: stream.reasoning.length,
        },
        { ...base, summarize: true },
      );
    }
  }, [showStream, stream]);

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
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        {messages.map((m) => (
          <div
            key={m.id}
            ref={
              m.id === lastUserId
                ? (el) => {
                    userMsgElRef.current = el;
                  }
                : undefined
            }
          >
            <MessageBubble message={m} />
          </div>
        ))}

        {onFollowUp && followUps.length > 0 ? (
          <FollowUpSuggestions suggestions={followUps} onPick={onFollowUp} />
        ) : null}

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

      {/* Send-anchor spacer — sized imperatively so the last user message can
       * park at the top of the viewport while the reply streams in. Outside
       * the gap-5 column so a 0-height spacer contributes no phantom gap. */}
      <div ref={spacerRef} aria-hidden className="shrink-0" />
    </div>
  );
}

const EMPTY_FOLLOW_UPS: ReadonlyArray<FollowUpSuggestion> = [];

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
