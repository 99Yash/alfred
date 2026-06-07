import type { SyncedChatMessage } from "@alfred/sync";
import { Loader2, ShieldQuestion } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { markChatTimingByAssistant } from "~/lib/chat/timing";
import type { StreamingMessage } from "~/lib/chat/use-chat-stream";
import { IntegrationGlyph, type IntegrationBrand } from "~/lib/integration-icons";
import { parseJsonRecord } from "~/lib/json-record";
import { cn } from "~/lib/utils";
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
  onFollowUp,
}: {
  messages: SyncedChatMessage[];
  stream: StreamingMessage | null;
  onFollowUp?: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const showStream = shouldShowStream(messages, stream);
  const followUps = useMemo(
    () => (showStream ? [] : buildFollowUpSuggestions(messages)),
    [messages, showStream],
  );

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
          <MessageBubble key={m.id} message={m} />
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
    </div>
  );
}

interface FollowUpSuggestion {
  id: string;
  text: string;
  brand: IntegrationBrand;
}

type PersistedToolCall = NonNullable<SyncedChatMessage["toolCalls"]>[number];

function buildFollowUpSuggestions(messages: readonly SyncedChatMessage[]): FollowUpSuggestion[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || last.status !== "complete") return [];

  const tools = last.toolCalls ?? [];
  const out: FollowUpSuggestion[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const suggestion = followUpForTool(tool);
    if (!suggestion || seen.has(suggestion.text)) continue;
    out.push(suggestion);
    seen.add(suggestion.text);
  }
  return out.slice(0, 2);
}

function followUpForTool(tool: PersistedToolCall): FollowUpSuggestion | null {
  if (tool.status !== "succeeded") return null;
  const result = parseJsonRecord(tool.resultPreview);
  if (!result) return null;

  if (tool.toolName === "github.search_pull_requests") {
    const totalCount = typeof result.totalCount === "number" ? result.totalCount : 0;
    const pullRequests = Array.isArray(result.pullRequests) ? result.pullRequests : [];
    if (totalCount <= 0 || pullRequests.length === 0) return null;
    return { id: "github-pr-list", text: "Show me the matching PRs.", brand: "github" };
  }

  if (tool.toolName === "calendar.list_events") {
    const events = Array.isArray(result.events) ? result.events : [];
    if (events.length === 0) return null;
    return {
      id: "calendar-meeting-prep",
      text: "What should I prep for my next meeting?",
      brand: "google_calendar",
    };
  }

  return null;
}

function FollowUpSuggestions({
  suggestions,
  onPick,
}: {
  suggestions: readonly FollowUpSuggestion[];
  onPick: (text: string) => void;
}) {
  return (
    <div className="animate-chat-in flex flex-wrap gap-2 pt-1">
      {suggestions.map((suggestion) => (
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
      <span>Waiting for your approval to take this action — review it below.</span>
    </div>
  );
}
