import type {
  SyncedActionStaging,
  SyncedArtifact,
  SyncedChatAttachment,
  SyncedChatMessage,
} from "@alfred/sync";
import { ArrowDown } from "lucide-react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Virtuoso, type Components, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import { markChatTimingByAssistant } from "~/lib/chat/timing";
import { useChatAttachmentsByMessage } from "~/lib/replicache/use-chat";
import { useThreadArtifacts } from "~/lib/replicache/use-artifacts";
import type { StreamingMessage } from "~/lib/chat/chat-stream-state";
import { SCROLL_CHAT_TO_BOTTOM_EVENT } from "~/lib/chat/use-run-complete";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { ArtifactTriggerCard } from "./artifact-trigger-card";
import {
  describeActivity,
  shouldShowStream,
  shouldShowThinkingIndicator,
  type FollowUpSuggestion,
} from "./conversation-helpers";
import { ChatApprovalTray } from "./approval-tray";
import { AssistantMarkdown, CopyMessageButton, MessageBubble } from "./message-bubble";
import { ReasoningSection } from "./reasoning-section";
import { SourcesStrip } from "./sources-strip";
import { ConnectNudgeRows } from "./connect-nudge-rows";
import { collectSources } from "./sources";
import { ToolCallGroup } from "./tool-call-group";

/**
 * Scrollable message feed: synced messages, then the live streaming bubble.
 * Sticks to the bottom unless the user scrolls up.
 * react-virtuoso windows the DOM (#496): compaction never deletes messages, so long threads grow forever.
 * Replicache only appends, so no prepend paging is needed.
 */
export function Conversation({
  messages,
  stream,
  onFollowUp,
  onRetry,
  followUps = EMPTY_FOLLOW_UPS,
  onOpenArtifact,
  openArtifactId,
  approvals = EMPTY_APPROVALS,
}: {
  messages: SyncedChatMessage[];
  stream: StreamingMessage | null;
  onFollowUp?: ((text: string) => void) | undefined;
  /** Re-send the user turn behind a failed reply, with its attachment ids and source message. */
  onRetry?:
    | ((text: string, retryAttachmentIds?: string[], retryAttachmentMessageId?: string) => void)
    | undefined;
  /** Follow-up chips under the last completed reply. */
  followUps?: ReadonlyArray<FollowUpSuggestion> | undefined;
  onOpenArtifact?: ((artifactId: string) => void) | undefined;
  /** The artifact open in the sidebar, so its card shows "Viewing". */
  openArtifactId?: string | null | undefined;
  /**
   * Pending approvals for the live run, shown at the tail of the streaming turn.
   * Each row disappears when its decision syncs.
   */
  approvals?: readonly SyncedActionStaging[] | undefined;
}) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // Virtuoso's `autoscrollToBottom` waits for `atBottomThreshold`, so small stream growth stays below the fold.
  // Pinning this element to `scrollHeight` follows the footer with no lag.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // The footer also grows between React updates (auto-animate, accordion, markdown reflow).
  // A ResizeObserver on it re-pins through that growth.
  const footerElRef = useRef<HTMLElement | null>(null);
  const footerResizeRef = useRef<ResizeObserver | null>(null);
  const stickRef = useRef(true);
  // Smooth jumps stall across many unmeasured rows, so use smooth only when the live edge is near.
  const lastRenderedIndexRef = useRef(0);
  // Lets the finished stream's copy button read the HTML before the durable copy syncs.
  const streamBodyRef = useRef<HTMLDivElement | null>(null);
  const [showJump, setShowJump] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const showStream = shouldShowStream(messages, stream);

  // Attachments grouped by message id (ADR-0065). One subscription for the feed.
  const threadId = messages[0]?.threadId;
  const attachmentsByMessage = useChatAttachmentsByMessage(threadId);

  // Artifacts grouped by authoring message (ADR-0075). A run can make more than one.
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

  // Leaves out the stream snapshot, so windowed rows do not re-render each streaming frame.
  const itemContext = useMemo<FeedItemContext>(
    () => ({
      messages,
      attachmentsByMessage,
      artifactsByMessage,
      onRetry,
      onOpenArtifact,
      openArtifactId,
    }),
    [messages, attachmentsByMessage, artifactsByMessage, onRetry, onOpenArtifact, openArtifactId],
  );

  const streamTimingRefs = useStreamRenderTiming(showStream ? stream : null);

  // ---- Follow the live edge -------------------------------------------
  // Scrolling up detaches; sending a new message re-attaches.
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];

      if (m && m.role === "user") return m.id;
    }

    return null;
  }, [messages]);

  // A new user message jumps to the live edge, even from far up.
  // `followOutput` only pins near the bottom, so the jump is explicit. Skip the mount run.
  // The jump-button reset happens during render; through the effect, a stale button shows for a frame.
  const firstUserTurn = useRef(true);
  const [prevLastUserId, setPrevLastUserId] = useState(lastUserId);

  if (lastUserId !== prevLastUserId) {
    setPrevLastUserId(lastUserId);

    if (!firstUserTurn.current) setShowJump(false);
  }

  useEffect(() => {
    if (firstUserTurn.current) {
      firstUserTurn.current = false;

      return;
    }

    stickRef.current = true;
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [lastUserId]);

  // Re-attach only. `releasePin` detaches, because the pin rewrites `scrollTop` before `atBottom` can flip.
  const onAtBottomChange = useCallback((atBottom: boolean) => {
    if (atBottom) {
      stickRef.current = true;
      setShowJump(false);
    }
  }, []);

  // Detect scroll-up intent (wheel up, touch drag), not a position delta.
  // The pin rewrites `scrollTop` every drip, so a position check loses the race.
  // Ignore downward wheels so this does not fight the pin.
  const releasePin = useCallback(() => {
    if (!stickRef.current) return;
    stickRef.current = false;
    setShowJump(true);
  }, []);

  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (e.deltaY < 0) releasePin();
    },
    [releasePin],
  );

  // Stable identity, so Virtuoso does not rebuild the listeners each render.
  const attachScroller = useCallback(
    (ref: HTMLElement | Window | null) => {
      const prev = scrollerElRef.current;

      if (prev) {
        prev.removeEventListener("wheel", onWheel);
        prev.removeEventListener("touchmove", releasePin);
      }

      const el = ref instanceof HTMLElement ? ref : null;
      scrollerElRef.current = el;

      if (el) {
        el.addEventListener("wheel", onWheel, { passive: true });
        el.addEventListener("touchmove", releasePin, { passive: true });
      }
    },
    [onWheel, releasePin],
  );

  const onRangeChanged = useCallback((range: ListRange) => {
    lastRenderedIndexRef.current = range.endIndex;
  }, []);

  // Pin to the bottom on each stream tick. The footer is not virtualized, so its height is exact.
  // `autoscrollToBottom` still runs to measure a new durable row that Virtuoso has not measured yet.
  // The read and write share one rAF; inline, they forced a reflow every drip.
  const pinRafRef = useRef<number | null>(null);

  const schedulePin = useCallback(() => {
    if (!stickRef.current) return;

    if (pinRafRef.current != null) return; // one pin per frame
    pinRafRef.current = requestAnimationFrame(() => {
      pinRafRef.current = null;

      if (!stickRef.current) return; // user scrolled up meanwhile
      const el = scrollerElRef.current;

      if (el) el.scrollTop = el.scrollHeight;
      virtuosoRef.current?.autoscrollToBottom();
    });
  }, []);

  useEffect(() => {
    schedulePin();
  }, [messages, stream, schedulePin]);

  // Re-pin on footer growth between React updates.
  // Pin synchronously here: after layout the read is cheap, and a rAF left the view ~30px behind.
  // Writing `scrollTop` does not resize the footer, so there is no feedback loop.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      if (!stickRef.current) return;
      const el = scrollerElRef.current;

      if (el) el.scrollTop = el.scrollHeight;
    });

    footerResizeRef.current = ro;

    if (footerElRef.current) ro.observe(footerElRef.current);

    return () => {
      ro.disconnect();
      footerResizeRef.current = null;
    };
  }, []);

  const setFooterEl = useCallback((el: HTMLElement | null) => {
    const ro = footerResizeRef.current;
    const prev = footerElRef.current;

    if (ro && prev) ro.unobserve(prev);
    footerElRef.current = el;

    if (ro && el) ro.observe(el);
  }, []);

  // Cancel a pending pin on unmount. A per-run cleanup would cancel the burst's pin.
  useEffect(
    () => () => {
      if (pinRafRef.current != null) cancelAnimationFrame(pinRafRef.current);
    },
    [],
  );

  // `scrollToIndex` measures rows as it goes, so it lands at the true bottom.
  // Smooth only near the edge or it stalls; instant under reduced motion.
  const jumpToBottom = useCallback(() => {
    stickRef.current = true;
    setShowJump(false);
    const lastIndex = Math.max(0, messages.length - 1);
    const near = lastIndex - lastRenderedIndexRef.current <= 25;
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: !reducedMotion && near ? "smooth" : "auto",
    });
  }, [reducedMotion, messages.length]);

  // The finish toast's "Open" action.
  const onScrollRequest = useEffectEvent(() => jumpToBottom());
  useEffect(() => {
    const handler = () => onScrollRequest();
    window.addEventListener(SCROLL_CHAT_TO_BOTTOM_EVENT, handler);

    return () => window.removeEventListener(SCROLL_CHAT_TO_BOTTOM_EVENT, handler);
  }, []);

  // The component stays mounted across thread navigations, so `initialTopMostItemIndex` cannot re-land.
  // The jump-button reset happens during render; the effect only jumps.
  const [prevThreadId, setPrevThreadId] = useState(threadId);

  if (threadId !== prevThreadId) {
    setPrevThreadId(threadId);
    setShowJump(false);
  }

  useEffect(() => {
    if (!threadId) return;
    stickRef.current = true;
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [threadId]);

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

  const footerValue = useMemo<FeedFooterValue>(
    () => ({
      showStream,
      stream,
      streamTimingRefs,
      streamBodyRef,
      followUps,
      onFollowUp,
      approvals,
      setFooterEl,
    }),
    [showStream, stream, streamTimingRefs, followUps, onFollowUp, approvals, setFooterEl],
  );

  const followOutput = useCallback(() => (stickRef.current ? ("auto" as const) : false), []);

  // Virtuoso reads this once on mount. Thread switches re-land through the effect above.
  const [initialIndex] = useState(() => ({
    index: Math.max(0, messages.length - 1),
    align: "end" as const,
  }));

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <FeedFooterContext value={footerValue}>
        <Virtuoso<SyncedChatMessage, FeedItemContext>
          ref={virtuosoRef}
          scrollerRef={attachScroller}
          data={messages}
          context={itemContext}
          computeItemKey={computeItemKey}
          itemContent={renderItem}
          components={FEED_COMPONENTS}
          followOutput={followOutput}
          atBottomThreshold={80}
          atBottomStateChange={onAtBottomChange}
          rangeChanged={onRangeChanged}
          initialTopMostItemIndex={initialIndex}
          increaseViewportBy={{ top: 800, bottom: 800 }}
          className="scroll-stable min-h-0 flex-1"
        />
      </FeedFooterContext>
      <ActivityPill
        show={showJump}
        activity={showStream && !stream.done ? describeActivity(stream) : null}
        onClick={jumpToBottom}
      />
    </div>
  );
}

// ---- Windowed rows ----------------------------------------------------

interface FeedItemContext {
  messages: SyncedChatMessage[];
  attachmentsByMessage: Record<string, SyncedChatAttachment[]>;
  artifactsByMessage: Map<string, SyncedArtifact[]>;
  onRetry?:
    | ((text: string, retryAttachmentIds?: string[], retryAttachmentMessageId?: string) => void)
    | undefined;
  onOpenArtifact?: ((artifactId: string) => void) | undefined;
  openArtifactId?: string | null | undefined;
}

const computeItemKey = (_: number, message: SyncedChatMessage) => message.id;

const renderItem = (index: number, message: SyncedChatMessage, context: FeedItemContext) => (
  <FeedRow index={index} message={message} context={context} />
);

/**
 * One message and its artifact cards. Memoized so streaming leaves rows alone.
 * `pb-5` replaces a gap, because virtualized items have none.
 */
const FeedRow = memo(function FeedRow({
  index,
  message,
  context,
}: {
  index: number;
  message: SyncedChatMessage;
  context: FeedItemContext;
}) {
  const { onOpenArtifact, openArtifactId } = context;

  const retry =
    context.onRetry && message.role === "assistant" && message.status === "failed"
      ? prevUserTurn(context.messages, index, context.attachmentsByMessage, context.onRetry)
      : undefined;

  const messageArtifacts = onOpenArtifact ? context.artifactsByMessage.get(message.id) : undefined;

  return (
    <div className="flex flex-col gap-5 pb-5">
      <MessageBubble
        message={message}
        attachments={context.attachmentsByMessage[message.id]}
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
    </div>
  );
});

// ---- Header / List / Footer chrome ------------------------------------
// Module-level so Virtuoso never remounts them. The footer reads the stream from context,
// not Virtuoso's `context`, which would re-render every row per frame.

interface FeedFooterValue {
  showStream: boolean;
  stream: StreamingMessage | null;
  streamTimingRefs: StreamRenderTiming;
  streamBodyRef: React.RefObject<HTMLDivElement | null>;
  followUps: ReadonlyArray<FollowUpSuggestion>;
  onFollowUp?: ((text: string) => void) | undefined;
  approvals: readonly SyncedActionStaging[];
  /** Registers the footer with the parent's re-pin observer. */
  setFooterEl: (el: HTMLElement | null) => void;
}

const FeedFooterContext = createContext<FeedFooterValue | null>(null);

function FeedList({
  style,
  children,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement>) {
  return (
    <div ref={ref} {...props} style={style} className="mx-auto w-full max-w-3xl px-4">
      {children}
    </div>
  );
}

function FeedHeader() {
  return <div className="h-6" />;
}

function FeedFooter() {
  const ctx = useContext(FeedFooterContext);

  if (!ctx) return <div className="h-6" />;

  const {
    showStream,
    stream,
    streamTimingRefs,
    streamBodyRef,
    followUps,
    onFollowUp,
    approvals,
    setFooterEl,
  } = ctx;

  // Sort approvals in tool-trail order. Ones with no tool card in the stream go last.
  const orderedApprovals = orderApprovalsByTool(approvals, stream);

  return (
    // Virtuoso renders the Footer as a sibling of the List, so match its column here.
    // Without it the bubble snaps width when the durable row syncs.
    <div ref={setFooterEl} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-6">
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

          {/* No `tools.length` gate: `ToolCallGroup` owns the empty case. */}
          <ToolCallGroup
            tools={stream.tools}
            narration={stream.narration}
            subAgents={stream.subAgents}
            active={!stream.done}
          />

          {/* The actions a gated run waits on, under the trail that proposed them. */}
          <ChatApprovalTray
            runId={stream.runId}
            approvals={orderedApprovals}
            awaitingApproval={stream.awaitingApproval}
          />

          {stream.compacting ? <ThinkingIndicator label="Condensing conversation…" /> : null}
          {stream.awaitingCapacity ? (
            <ThinkingIndicator label="Waiting for model capacity…" />
          ) : null}

          {stream.text.length > 0 ? (
            <div ref={streamBodyRef}>
              <div ref={streamTimingRefs.text}>
                <AssistantMarkdown text={stream.text} streaming={!stream.done} />
              </div>
            </div>
          ) : shouldShowThinkingIndicator(stream) ? (
            <div ref={streamTimingRefs.thinking}>
              <ThinkingIndicator />
            </div>
          ) : null}

          {/* A connection bounce can land mid-turn (#378 item 3). */}
          {stream.connectNudges.length > 0 ? (
            <ConnectNudgeRows nudges={stream.connectNudges} />
          ) : null}

          {stream.error ? (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] leading-snug text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200"
            >
              {stream.error}
            </div>
          ) : null}

          {stream.done ? <SourcesStrip sources={collectSources(stream.tools)} /> : null}

          {/* Holds the copy button until the durable copy syncs in. */}
          {stream.done && stream.text.length > 0 ? (
            <CopyMessageButton content={stream.text} htmlRef={streamBodyRef} />
          ) : null}

          {stream.done ? <span ref={streamTimingRefs.done} hidden /> : null}
        </div>
      ) : null}
    </div>
  );
}

const FEED_COMPONENTS: Components<SyncedChatMessage, FeedItemContext> = {
  Header: FeedHeader,
  List: FeedList,
  Footer: FeedFooter,
};

/**
 * Bind a retry for the user turn before a failed reply.
 * Retryable with text or a ready attachment; attachment ids go along (ADR-0065).
 * Attachment failures also get a text-only retry when there is text.
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
      ...(text.trim().length > 0 ? { withoutAttachments: () => onRetry(text, undefined) } : {}),
    };
  }

  return undefined;
}

/**
 * Jump-to-latest button, shown when the user scrolls up.
 * While streaming it widens into a pill that names the current step.
 */
function ActivityPill({
  show,
  activity,
  onClick,
}: {
  show: boolean;
  activity: string | null;
  onClick: () => void;
}) {
  return (
    // Only the button takes pointer events.
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
      <button
        type="button"
        onClick={onClick}
        aria-label={activity ? `${activity} Scroll to latest.` : "Scroll to latest"}
        disabled={!show}
        tabIndex={show ? 0 : -1}
        className={cn(
          "inline-flex h-9 items-center rounded-full",
          "bg-app-bg-1 text-app-fg-3 shadow-[0_4px_12px_rgba(0,0,0,0.16),inset_0_0_0_1px_var(--app-fg-a1)]",
          "transition-[opacity,scale] duration-150 ease-out",
          "hover:scale-105 hover:text-app-fg-4 active:scale-95",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          activity ? "max-w-[min(20rem,70vw)] gap-2 pr-3 pl-2" : "size-9 justify-center",
          show ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {activity ? (
          <>
            <span aria-hidden className="chat-think-mark inline-flex shrink-0">
              <img
                src="/images/logo/alfred-logo.svg"
                alt=""
                className="size-[18px] rounded-[5px]"
              />
            </span>
            <span className="animate-chat-shimmer-mask min-w-0 truncate text-[13px] font-medium text-app-fg-4">
              {activity}
            </span>
            <ArrowDown size={13} aria-hidden className="shrink-0 text-app-fg-2" />
          </>
        ) : (
          <ArrowDown size={16} />
        )}
      </button>
    </div>
  );
}

const EMPTY_FOLLOW_UPS: ReadonlyArray<FollowUpSuggestion> = [];

const EMPTY_APPROVALS: readonly SyncedActionStaging[] = [];

/** Sort approvals in tool-trail order. Ones with no tool card go last, by `createdAt`. */
function orderApprovalsByTool(
  approvals: readonly SyncedActionStaging[],
  stream: StreamingMessage | null,
): readonly SyncedActionStaging[] {
  if (approvals.length <= 1) return approvals;
  const toolOrder = new Map<string, number>();
  stream?.tools.forEach((tool, i) => toolOrder.set(tool.toolCallId, i));

  return approvals.toSorted((a, b) => {
    const ia = toolOrder.get(a.toolCallId) ?? Number.POSITIVE_INFINITY;
    const ib = toolOrder.get(b.toolCallId) ?? Number.POSITIVE_INFINITY;

    if (ia !== ib) return ia - ib;

    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** Reduced-motion preference, SSR-safe. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => getReducedMotionSnapshot(),
    () => false,
  );
}

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};

  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  mql.addEventListener("change", onChange);

  return () => mql.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;

  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface StreamRenderTiming {
  thinking: (el: HTMLDivElement | null) => void;
  reasoning: (el: HTMLDivElement | null) => void;
  text: (el: HTMLDivElement | null) => void;
  done: (el: HTMLSpanElement | null) => void;
}

function useStreamRenderTiming(stream: StreamingMessage | null): StreamRenderTiming {
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
  // No dep array: `callback` is new each render, so resync every commit.
  useEffect(() => {
    callbackRef.current = callback;
  });

  return useMemo(() => (el: T | null) => callbackRef.current(el), []);
}

/** Apple platforms show ⌥ instead of "Alt+". */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.userAgent);

function FollowUpSuggestions({
  suggestions,
  onPick,
}: {
  suggestions: readonly FollowUpSuggestion[];
  onPick: (text: string) => void;
}) {
  const onPickEvent = useEffectEvent(onPick);
  // ⌥1…⌥9 picks a chip. Use `e.code`: Option+digit types a glyph on macOS.
  // Alt+digit is free in browsers; ⌘digit switches tabs.
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
            "bg-app-bg-2/70 text-[13px] leading-snug font-medium text-app-fg-3",
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
                "inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-md px-1",
                "font-sans text-[10px] leading-none font-medium tabular-nums",
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

function ThinkingIndicator({ label = "Thinking…" }: { label?: string }) {
  return (
    <div className="animate-chat-in flex items-center gap-2.5 text-[14px] text-app-fg-3">
      {/* Pulsing Alfred mark instead of a spinner. */}
      <span className="chat-think-mark inline-flex shrink-0">
        <img src="/images/logo/alfred-logo.svg" alt="" className="size-[18px] rounded-[5px]" />
      </span>
      <span className="animate-chat-shimmer">{label}</span>
    </div>
  );
}
