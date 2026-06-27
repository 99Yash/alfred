import type { SyncedArtifact, SyncedChatAttachment, SyncedChatMessage } from "@alfred/sync";
import { ArrowDown, ShieldQuestion } from "lucide-react";
import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { markChatTimingByAssistant } from "~/lib/chat/timing";
import { useChatAttachmentsByMessage } from "~/lib/replicache/use-chat";
import { useThreadArtifacts } from "~/lib/replicache/use-artifacts";
import type { StreamingMessage } from "~/lib/chat/use-chat-stream";
import { SCROLL_CHAT_TO_BOTTOM_EVENT } from "~/lib/chat/use-run-complete";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { ArtifactTriggerCard } from "./artifact-trigger-card";
import { shouldShowStream, type FollowUpSuggestion } from "./conversation-helpers";
import { AssistantMarkdown, CopyMessageButton, MessageBubble } from "./message-bubble";
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
  onRetry,
  followUps = EMPTY_FOLLOW_UPS,
  onOpenArtifact,
  openArtifactId,
}: {
  messages: SyncedChatMessage[];
  stream: StreamingMessage | null;
  onFollowUp?: (text: string) => void;
  /**
   * Re-send the user turn behind a failed reply (the "Retry" affordance). The
   * second arg carries that turn's attachment ids, and the third binds those ids
   * to their source user message so the server can scope the copy.
   */
  onRetry?: (
    text: string,
    retryAttachmentIds?: string[],
    retryAttachmentMessageId?: string,
  ) => void;
  /** Follow-up chips rendered under the last completed reply (built by the parent). */
  followUps?: ReadonlyArray<FollowUpSuggestion>;
  /** Opens an artifact in the sidebar (from a message's trigger card). */
  onOpenArtifact?: (artifactId: string) => void;
  /** The artifact currently open in the sidebar, so its card shows "Viewing". */
  openArtifactId?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  // Last observed scrollTop, so `onScroll` can tell a real user scroll-up (the
  // value drops) from content growing under a pinned viewport (the value holds
  // or rises). Without this, a streaming burst taller than the detach threshold
  // — a reply paragraph, the tool trail expanding — lands between our
  // programmatic scroll-to-bottom and the deferred scroll event, reads as "far
  // from bottom", and wrongly detaches stick, stranding the live edge.
  const lastScrollTopRef = useRef(0);
  // Body of the just-finished stream, so its copy button can lift the rendered
  // HTML before the durable copy syncs in and takes over (see below).
  const streamBodyRef = useRef<HTMLDivElement | null>(null);
  // Drives the floating "scroll to latest" button — shown only while the user
  // has scrolled up off the live edge.
  const [showJump, setShowJump] = useState(false);

  const showStream = shouldShowStream(messages, stream);

  // Attachments for this thread, grouped by message id (ADR-0065). One
  // subscription for the whole feed; each bubble looks up its own.
  const threadId = messages[0]?.threadId;
  const attachmentsByMessage = useChatAttachmentsByMessage(threadId);

  // Agent-produced artifacts for this thread (ADR-0075), grouped by the
  // assistant message that authored each one — that message renders a trigger
  // card. A run can produce more than one artifact, so the value is a list.
  const threadArtifacts = useThreadArtifacts(threadId);
  const artifactsByMessage = useMemo(() => {
    const map = new Map<string, SyncedArtifact[]>();
    for (const artifact of threadArtifacts) {
      if (!artifact.messageId) continue;
      const list = map.get(artifact.messageId);
      if (list) list.push(artifact);
      else map.set(artifact.messageId, [artifact]);
    }
    return map;
  }, [threadArtifacts]);

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

  // Detach only on a genuine upward user scroll (scrollTop actually drops);
  // re-attach once they return to the bottom (within 80px). Content growth never
  // lowers scrollTop, so a fast streaming burst can't masquerade as a scroll-up
  // and falsely detach. Programmatic scroll-to-bottom raises scrollTop, so it
  // re-confirms the attached state rather than tripping the detach.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current - 1;
    lastScrollTopRef.current = el.scrollTop;
    if (atBottom) stickRef.current = true;
    else if (scrolledUp) stickRef.current = false;
    setShowJump(!stickRef.current);
  };

  // Jump back to the live edge and re-engage stick-to-bottom. Smooth so the
  // motion reads as "catching up" rather than a teleport.
  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  // The finish toast's "Open" action jumps back to the live edge — useful when
  // the user had scrolled up before the away-reply landed.
  const onScrollRequest = useEffectEvent(() => jumpToBottom());
  useEffect(() => {
    const handler = () => onScrollRequest();
    window.addEventListener(SCROLL_CHAT_TO_BOTTOM_EVENT, handler);
    return () => window.removeEventListener(SCROLL_CHAT_TO_BOTTOM_EVENT, handler);
  }, []);

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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto scroll-stable"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {messages.map((m, i) => {
            const retry =
              onRetry && m.role === "assistant" && m.status === "failed"
                ? prevUserTurn(messages, i, attachmentsByMessage, onRetry)
                : undefined;
            const messageArtifacts = onOpenArtifact ? artifactsByMessage.get(m.id) : undefined;
            return (
              <Fragment key={m.id}>
                <MessageBubble
                  message={m}
                  attachments={attachmentsByMessage[m.id]}
                  onRetry={retry?.same}
                  onRetryWithoutAttachments={retry?.withoutAttachments}
                />
                {messageArtifacts && onOpenArtifact
                  ? messageArtifacts.map((artifact) => (
                      <ArtifactTriggerCard
                        key={artifact.id}
                        artifact={artifact}
                        active={artifact.id === openArtifactId}
                        onOpen={onOpenArtifact}
                      />
                    ))
                  : null}
              </Fragment>
            );
          })}

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
                <ToolCallGroup
                  tools={stream.tools}
                  narration={stream.narration}
                  active={!stream.done}
                />
              ) : null}

              {stream.text.length > 0 ? (
                <div ref={streamBodyRef}>
                  <div ref={streamTimingRefs.text}>
                    <AssistantMarkdown text={stream.text} streaming={!stream.done} />
                  </div>
                </div>
              ) : stream.tools.length === 0 &&
                stream.reasoning.length === 0 &&
                !stream.reasoningActive ? (
                <div ref={streamTimingRefs.thinking}>
                  <ThinkingIndicator />
                </div>
              ) : null}

              {stream.done ? <SourcesStrip sources={collectSources(stream.tools)} /> : null}

              {/* The live bubble holds the copy affordance during the brief window
               * between "done" and the durable copy syncing in (which then renders
               * its own MessageBubble copy button). */}
              {stream.done && stream.text.length > 0 ? (
                <CopyMessageButton content={stream.text} htmlRef={streamBodyRef} />
              ) : null}

              {stream.awaitingApproval ? <ApprovalNotice /> : null}
              {stream.done ? <span ref={streamTimingRefs.done} hidden /> : null}
            </div>
          ) : null}
        </div>
      </div>
      <ScrollToBottomButton show={showJump} onClick={jumpToBottom} />
    </div>
  );
}

/**
 * Resolves the user message preceding a failed reply into a bound retry handler.
 * A turn is retryable when it has text *or* at least one ready attachment — the
 * latter is what makes an image-only turn (empty content) retryable. The ready
 * attachments' ids ride along so the server can copy their bytes onto the new
 * message (ADR-0065). Attachment-specific failures also get a text-only retry
 * when there is text to salvage.
 */
function prevUserTurn(
  messages: readonly SyncedChatMessage[],
  failedIndex: number,
  attachmentsByMessage: Record<string, SyncedChatAttachment[]>,
  onRetry: (text: string, retryAttachmentIds?: string[], retryAttachmentMessageId?: string) => void,
): { same: () => void; withoutAttachments?: () => void } | undefined {
  for (let i = failedIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const readyIds = (attachmentsByMessage[m.id] ?? []).reduce<string[]>((ids, a) => {
      if (a.status === "ready") ids.push(a.id);
      return ids;
    }, []);
    if (m.content.trim().length === 0 && readyIds.length === 0) continue;
    const text = m.content;
    return {
      same: () => onRetry(text, readyIds.length > 0 ? readyIds : undefined, m.id),
      withoutAttachments: text.trim().length > 0 ? () => onRetry(text, undefined) : undefined,
    };
  }
  return undefined;
}

/**
 * Floating jump-to-latest control. Appears only when the user has scrolled up
 * off the live edge; clicking re-attaches stick-to-bottom. Borrowed from
 * dimension's chat, whose long threads surface the same affordance.
 */
function ScrollToBottomButton({ show, onClick }: { show: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Scroll to latest"
      disabled={!show}
      tabIndex={show ? 0 : -1}
      className={cn(
        "absolute bottom-4 left-1/2 z-10 -translate-x-1/2",
        "inline-flex size-9 items-center justify-center rounded-full",
        "bg-app-bg-1 text-app-fg-3 shadow-[0_4px_12px_rgba(0,0,0,0.16),inset_0_0_0_1px_var(--app-fg-a1)]",
        "transition-[opacity,scale] duration-150 ease-out",
        "hover:text-app-fg-4 hover:scale-105 active:scale-95",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
        show ? "opacity-100" : "pointer-events-none opacity-0 disabled:cursor-default",
      )}
    >
      <ArrowDown size={16} />
    </button>
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
            "group/chip inline-flex min-h-10 max-w-full items-center gap-2 rounded-full px-3.5 text-left",
            "bg-app-bg-2/70 text-[13px] font-medium leading-snug text-app-fg-3",
            "shadow-[inset_0_0_0_1px_var(--app-fg-a1)]",
            "transition-[background-color,color,translate,box-shadow] duration-150 ease-out",
            "hover:-translate-y-px hover:bg-app-bg-a2 hover:text-app-fg-4 hover:shadow-[inset_0_0_0_1px_var(--app-fg-a2)]",
            "active:translate-y-0 active:scale-[0.97]",
            "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          )}
        >
          <IntegrationGlyph brand={suggestion.brand} size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{suggestion.text}</span>
          {i < 9 ? (
            <kbd
              className={cn(
                "shrink-0 inline-flex items-center justify-center h-[17px] min-w-[17px] px-1 rounded-md",
                "text-[10px] leading-none font-medium font-sans tabular-nums",
                "bg-app-bg-a2 text-app-fg-2 transition-colors duration-150",
                "group-hover/chip:bg-app-bg-3 group-hover/chip:text-app-fg-3",
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
    <div className="animate-chat-in flex items-center gap-2.5 text-[14px] text-app-fg-3">
      {/* Branded pulsing mark in place of a generic spinner — the Alfred glyph
       * breathes inside a soft halo while the turn spins up. Mirrors
       * dimension's pulsing AI icon to the left of its working state. */}
      <span className="chat-think-mark inline-flex shrink-0">
        <img src="/images/logo/alfred-logo.svg" alt="" className="size-[18px] rounded-[5px]" />
      </span>
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
