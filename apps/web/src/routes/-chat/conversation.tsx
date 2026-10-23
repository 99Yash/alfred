import type {
  SyncedActionStaging,
  SyncedArtifact,
  SyncedChatAttachment,
  SyncedChatMessage,
} from "@alfred/sync";
import { ArrowDown, MessageCircleQuestion } from "lucide-react";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Virtuoso,
  type Components,
  type ContextProp,
  type ListProps,
  type ListRange,
  type VirtuosoHandle,
} from "react-virtuoso";
import { asQuestionStaging } from "~/components/approvals/ask-user";
import { ToolIcon } from "~/components/approvals/tool-icon";
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
  reviewLabel,
  shouldShowStream,
  shouldShowThinkingIndicator,
  type FollowUpSuggestion,
} from "./conversation-helpers";
import { ChatApprovalTray } from "./approval-tray";
import { AssistantMarkdown, CopyMessageButton, MessageBubble } from "./message-bubble";
import { ReasoningSection, ThinkingClock } from "./reasoning-section";
import { SourcesStrip } from "./sources-strip";
import { ConnectNudgeRows } from "./connect-nudge-rows";
import { collectSources } from "./sources";
import { ToolCallGroup } from "./tool-call-group";
import { CHAT_POP, CHAT_SWAP, usePrefersReducedMotion } from "./motion";
import { MESSAGE_ID_ATTR, useQuestionAnchor } from "./use-question-anchor";

/**
 * Scrollable message feed: synced messages, then the live streaming bubble.
 * A new question moves to the top, and the reply fills the space below it (`useQuestionAnchor`).
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
  // Smooth jumps stall across many unmeasured rows, so use smooth only when the live edge is near.
  const lastRenderedIndexRef = useRef(0);
  // Lets the finished stream's copy button read the HTML before the durable copy syncs.
  const streamBodyRef = useRef<HTMLDivElement | null>(null);
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

  const onRangeChanged = useCallback((range: ListRange) => {
    lastRenderedIndexRef.current = range.endIndex;
  }, []);

  const isNearLiveEdge = useCallback(
    () => Math.max(0, messages.length - 1) - lastRenderedIndexRef.current <= 25,
    [messages.length],
  );

  const {
    attachScroller,
    scrollerElRef,
    setListEl,
    setFooterEl,
    belowFold,
    anchored,
    initialLocation,
  } = useQuestionAnchor({
    virtuosoRef,
    messages,
    threadId,
    live: showStream && !stream.done,
    liveKey: showStream && !stream.done ? stream.runId : null,
    smoothAnchor: () => !reducedMotion && isNearLiveEdge(),
  });

  // Leaves out the stream snapshot, so windowed rows do not re-render each streaming frame.
  const itemContext = useMemo<FeedItemContext>(
    () => ({
      messages,
      attachmentsByMessage,
      artifactsByMessage,
      onRetry,
      onOpenArtifact,
      openArtifactId,
      setListEl,
    }),
    [
      messages,
      attachmentsByMessage,
      artifactsByMessage,
      onRetry,
      onOpenArtifact,
      openArtifactId,
      setListEl,
    ],
  );

  const streamTimingRefs = useStreamRenderTiming(showStream ? stream : null);

  // `scrollToIndex` measures rows as it goes, so it lands at the true bottom.
  // Smooth only near the edge or it stalls; instant under reduced motion.
  // One jump: the view does not follow the reply after it.
  const jumpToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({
      index: "LAST",
      align: "end",
      behavior: !reducedMotion && isNearLiveEdge() ? "smooth" : "auto",
    });
  }, [reducedMotion, isNearLiveEdge]);

  // ---- Jump to a pending approval -------------------------------------
  // Trail order, so the pill and the tray agree on which card is first.
  const orderedApprovals = useMemo(
    () => orderApprovalsByTool(approvals, stream),
    [approvals, stream],
  );

  // The tray's card list. Only a mounted card sets it; the waiting placeholder has no card.
  const [trayEl, setTrayEl] = useState<HTMLDivElement | null>(null);
  // Keyed by element, so a new tray reads as in view until its own first callback (no "review" flash).
  const [trayView, setTrayView] = useState<{ el: HTMLDivElement; inView: boolean } | null>(null);
  const trayInView = trayEl === null || trayView?.el !== trayEl || trayView.inView;

  // Root is the feed scroller, so the bottom margin is the pill zone, not the composer.
  useEffect(() => {
    if (!trayEl || typeof IntersectionObserver === "undefined") return;

    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);

        if (entry) setTrayView({ el: trayEl, inView: entry.isIntersecting });
      },
      { root: scrollerElRef.current, rootMargin: `0px 0px -${PILL_ZONE_PX}px 0px`, threshold: 0 },
    );

    io.observe(trayEl);

    return () => io.disconnect();
  }, [trayEl, scrollerElRef]);

  // Near: one scroll. Far: land at the live edge first so Virtuoso measures the rows above the
  // tray, then move to the card a frame later.
  const jumpToApproval = useCallback(() => {
    const el = trayEl;

    if (!el) return;

    if (isNearLiveEdge()) {
      el.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });

      return;
    }

    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }, [trayEl, isNearLiveEdge, reducedMotion]);

  // The finish toast's "Open" action.
  const onScrollRequest = useEffectEvent(() => jumpToBottom());
  useEffect(() => {
    const handler = () => onScrollRequest();
    window.addEventListener(SCROLL_CHAT_TO_BOTTOM_EVENT, handler);

    return () => window.removeEventListener(SCROLL_CHAT_TO_BOTTOM_EVENT, handler);
  }, []);

  // A switch usually remounts the feed (the shell shows a loader first), so
  // `initialTopMostItemIndex` lands it. This covers the stay-mounted path.
  // A thread with a live run anchors its question instead (the hook scrolls).
  useEffect(() => {
    if (!threadId || anchored) return;
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [threadId, anchored]);

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
      orderedApprovals,
      setFooterEl,
      setTrayEl,
    }),
    [showStream, stream, streamTimingRefs, followUps, onFollowUp, orderedApprovals, setFooterEl],
  );

  const firstApproval = orderedApprovals[0];
  const approvalLabel = reviewLabel(orderedApprovals);

  const pillState: PillState =
    trayEl && !trayInView && approvalLabel && firstApproval
      ? { kind: "review", label: approvalLabel, first: firstApproval }
      : showStream && !stream.done
        ? { kind: "activity", label: describeActivity(stream) }
        : { kind: "latest" };

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
          rangeChanged={onRangeChanged}
          initialTopMostItemIndex={initialLocation}
          increaseViewportBy={{ top: 800, bottom: 800 }}
          className="scroll-stable min-h-0 flex-1"
        />
      </FeedFooterContext>
      <ActivityPill
        show={belowFold}
        state={pillState}
        onClick={jumpToBottom}
        onReview={jumpToApproval}
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
  /** Registers the list element with the question anchor (the rows tail). Stable, so rows do not re-render. */
  setListEl: (el: HTMLElement | null) => void;
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
    <div {...{ [MESSAGE_ID_ATTR]: message.id }} className="flex flex-col gap-5 pb-5">
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
  /** Pending approvals in tool-trail order. Ones with no tool card in the stream go last. */
  orderedApprovals: readonly SyncedActionStaging[];
  /** Registers the footer content box with the question anchor (reserve and pill). */
  setFooterEl: (el: HTMLElement | null) => void;
  /** Registers the approval card list with the parent's jump-to-card pill. */
  setTrayEl: (el: HTMLDivElement | null) => void;
}

const FeedFooterContext = createContext<FeedFooterValue | null>(null);

function FeedList({
  style,
  children,
  ref,
  context: { setListEl },
  ...props
}: ListProps & ContextProp<FeedItemContext>) {
  // One callback ref: Virtuoso's own ref, then the question anchor's.
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (ref && "current" in ref) ref.current = el;
      else ref?.(el);
      setListEl(el);
    },
    [ref, setListEl],
  );

  return (
    <div ref={attach} {...props} style={style} className="mx-auto w-full max-w-3xl px-4">
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
    streamTimingRefs: {
      thinking: thinkingRef,
      reasoning: reasoningRef,
      text: textRef,
      done: doneRef,
    },
    streamBodyRef,
    followUps,
    onFollowUp,
    orderedApprovals,
    setFooterEl,
    setTrayEl,
  } = ctx;

  return (
    // Virtuoso renders the Footer as a sibling of the List, so match its column here.
    // Without it the bubble snaps width when the durable row syncs.
    // The question anchor owns this element's `min-height` (the reserve), so no style here.
    <div ref={setFooterEl} className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-6">
      {/* `initial={false}`: chips already there when the thread opens do not animate in. */}
      <AnimatePresence initial={false}>
        {onFollowUp && followUps.length > 0 ? (
          <FollowUpSuggestions key="follow-ups" suggestions={followUps} onPick={onFollowUp} />
        ) : null}
      </AnimatePresence>

      {showStream && stream ? (
        <div key={`${stream.messageId}:${stream.runId}`} className="flex flex-col gap-2">
          {stream.reasoning.length > 0 || stream.reasoningActive ? (
            <div ref={stream.reasoning.length > 0 ? reasoningRef : undefined}>
              <ReasoningSection
                reasoning={stream.reasoning}
                active={stream.reasoningActive}
                durationMs={stream.reasoningMs}
                startedTs={stream.turnStartedTs}
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
            ref={setTrayEl}
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
              <div ref={textRef}>
                <AssistantMarkdown text={stream.text} streaming={!stream.done} />
              </div>
            </div>
          ) : shouldShowThinkingIndicator(stream) ? (
            <div ref={thinkingRef}>
              <ThinkingIndicator
                label="Thinking"
                clock={
                  <ThinkingClock startedTs={stream.turnStartedTs} durationMs={stream.reasoningMs} />
                }
              />
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

          {/* Holds the copy button until the durable copy syncs in. It fades in once, here;
              the durable button that replaces it does not, so the handoff does not blink. */}
          {stream.done && stream.text.length > 0 ? (
            <div className="animate-chat-in">
              <CopyMessageButton content={stream.text} htmlRef={streamBodyRef} />
            </div>
          ) : null}

          {stream.done ? <span ref={doneRef} hidden /> : null}
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

/** The floating pill's band at the feed bottom (`bottom-4` + `h-9`, rounded up). A card under it is not in view. */
const PILL_ZONE_PX = 64;

/** What the floating pill offers. One union, so a new state does not add a second content prop. */
type PillState =
  | { kind: "latest" }
  | { kind: "activity"; label: string }
  | { kind: "review"; label: string; first: SyncedActionStaging };

interface PillFace {
  /** Keys the icon crossfade. */
  iconKey: string;
  icon: React.ReactNode;
  label: string;
  ariaLabel: string;
  /** Shimmer the label: the run is working, not waiting on the user. */
  working: boolean;
}

/** The labelled pill content for each state, or `null` for the bare arrow. */
function pillFace(state: PillState): PillFace | null {
  switch (state.kind) {
    case "latest":
      return null;
    case "activity":
      return {
        iconKey: "alfred",
        icon: (
          <span className="chat-think-mark inline-flex">
            <img src="/images/logo/alfred-logo.svg" alt="" className="size-[18px] rounded-[5px]" />
          </span>
        ),
        label: state.label,
        ariaLabel: `${state.label} Scroll to latest.`,
        working: true,
      };
    case "review": {
      // A question is not an approval (ADR-0099): the chime toast's glyph, not the tool's brand.
      const question = asQuestionStaging(state.first) !== null;

      return {
        iconKey: question ? "question" : `tool:${state.first.integration}`,
        icon: question ? (
          <MessageCircleQuestion size={16} className="text-app-purple-3" />
        ) : (
          <ToolIcon integration={state.first.integration} size="xs" />
        ),
        label: state.label,
        ariaLabel: `${state.label}. Scroll to it.`,
        working: false,
      };
    }

    default: {
      const _exhaustive: never = state;

      return _exhaustive;
    }
  }
}

/**
 * Jump button, shown while the live end is below the fold (`belowFold`).
 * While streaming it widens into a pill that names the current step.
 * When an approval card waits off-screen, it names the card and jumps to it instead.
 */
function ActivityPill({
  show,
  state,
  onClick,
  onReview,
}: {
  show: boolean;
  state: PillState;
  /** Jump to the latest message. */
  onClick: () => void;
  /** Jump to the first pending approval card. */
  onReview: () => void;
}) {
  const prefersReduced = usePrefersReducedMotion();
  const face = pillFace(state);
  // Pixel-to-pixel width tween. Motion leaves a settled `"auto"` target as the string
  // `"auto"`, so an `"auto" -> 36` shrink after a settled grow measures 36 -> 36 and
  // snaps (round 0). The label content is measured instead; the last measured width
  // is kept for the exit so the shrink starts from a number. The label group is
  // `shrink-0` with the `max-w` cap (not a `min-w-0` flex child of the tweened
  // button), so `offsetWidth` reads its natural width at every button width (round 1).
  // One labelled group serves both the activity and the review face, so this one ref
  // never points at a group that is leaving; the icon and the text crossfade inside it.
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const [labelWidth, setLabelWidth] = useState<number | null>(null);
  const label = face?.label ?? null;

  useLayoutEffect(() => {
    const el = labelRef.current;

    if (!el) return;
    const measure = () => setLabelWidth(el.offsetWidth);

    measure();

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    return () => ro.disconnect();
  }, [label]);

  return (
    // Only the button takes pointer events.
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
      <m.button
        type="button"
        onClick={state.kind === "review" ? onReview : onClick}
        aria-label={face ? face.ariaLabel : "Scroll to latest"}
        disabled={!show}
        tabIndex={show ? 0 : -1}
        // A width tween, not `layout`: `domAnimation` can reach pixel widths without the layout feature.
        // `prefersReduced` is the live hook in motion.tsx: this button lives for the whole thread,
        // so motion's mount-time check would miss a reduce change mid-thread.
        animate={{ width: face ? (labelWidth ?? "auto") : 36 }}
        transition={prefersReduced ? { duration: 0 } : CHAT_POP}
        className={cn(
          "relative inline-flex h-9 items-center justify-center overflow-hidden rounded-full",
          "bg-app-bg-1 text-app-fg-3 shadow-[0_4px_12px_rgba(0,0,0,0.16),inset_0_0_0_1px_var(--app-fg-a1)]",
          "transition-[opacity,scale] duration-150 ease-out",
          "hover:scale-105 hover:text-app-fg-4 active:scale-95",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
          show ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {/* `popLayout` lifts the leaving content out of flow, so "auto" measures only the new content. */}
        <AnimatePresence mode="popLayout" initial={false}>
          {face ? (
            <m.span
              key="label"
              ref={labelRef}
              className="inline-flex max-w-[min(20rem,70vw)] shrink-0 items-center gap-2 pr-3 pl-2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={CHAT_SWAP}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <m.span
                  key={face.iconKey}
                  aria-hidden
                  className="inline-flex shrink-0"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={CHAT_SWAP}
                >
                  {face.icon}
                </m.span>
              </AnimatePresence>
              <AnimatePresence mode="popLayout" initial={false}>
                <m.span
                  key={face.label}
                  className={cn(
                    "min-w-0 truncate text-[13px] font-medium text-app-fg-4",
                    face.working && "animate-chat-shimmer-mask",
                  )}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={CHAT_SWAP}
                >
                  {face.label}
                </m.span>
              </AnimatePresence>
              <ArrowDown size={13} aria-hidden className="shrink-0 text-app-fg-2" />
            </m.span>
          ) : (
            <m.span
              key="arrow"
              className="inline-flex size-9 shrink-0 items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={CHAT_SWAP}
            >
              <ArrowDown size={16} />
            </m.span>
          )}
        </AnimatePresence>
      </m.button>
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
  const isPresent = useIsPresent();
  // Live hook (not motion's mount-time snapshot): this row lives from the end of
  // one turn to the next send, so `height` and `marginBottom` need a call-site
  // gate (see motion.tsx). Opacity alone may still fade.
  const prefersReduced = usePrefersReducedMotion();
  // ⌥1…⌥9 picks a chip. Use `e.code`: Option+digit types a glyph on macOS.
  // Alt+digit is free in browsers; ⌘digit switches tabs.
  useEffect(() => {
    // A leaving row takes no shortcut while it fades out under a new turn.
    if (!isPresent) return;

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
  }, [suggestions, isPresent]);

  return (
    <m.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      // Collapse, not just fade: the stream block mounts below in the same commit.
      // The -20 cancels the column's `gap-5`, so the stream ends where the chips began.
      exit={{ opacity: 0, height: 0, marginBottom: -20 }}
      transition={
        prefersReduced
          ? { ...CHAT_POP, height: { duration: 0 }, marginBottom: { duration: 0 } }
          : CHAT_POP
      }
      inert={!isPresent}
      // Clip only while leaving, so the chip focus rings show at rest.
      className={cn("flex flex-wrap gap-2 pt-1", !isPresent && "overflow-hidden")}
    >
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
    </m.div>
  );
}

function ThinkingIndicator({
  label = "Thinking…",
  clock,
}: {
  label?: string;
  /** Counts up after the label, so the wait reads as work in progress. */
  clock?: React.ReactNode;
}) {
  return (
    <div className="animate-chat-in flex items-center gap-2.5 text-[14px] text-app-fg-3">
      {/* Pulsing Alfred mark instead of a spinner. */}
      <span className="chat-think-mark inline-flex shrink-0">
        <img src="/images/logo/alfred-logo.svg" alt="" className="size-[18px] rounded-[5px]" />
      </span>
      <span className="animate-chat-shimmer">
        {label}
        {clock}
      </span>
    </div>
  );
}
