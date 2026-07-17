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
import type { StreamingMessage } from "~/lib/chat/use-chat-stream";
import { SCROLL_CHAT_TO_BOTTOM_EVENT } from "~/lib/chat/use-run-complete";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { ArtifactTriggerCard } from "./artifact-trigger-card";
import {
  describeActivity,
  shouldShowStream,
  type FollowUpSuggestion,
} from "./conversation-helpers";
import { ChatApprovalTray } from "./approval-tray";
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
 *
 * The durable transcript is windowed by react-virtuoso (issue #496): because
 * backend compaction never deletes raw messages, a long thread's rendered node
 * count would otherwise grow without bound. Only rows near the viewport stay
 * mounted; the rest are virtualized in on scroll. The full message array still
 * lives in memory (Replicache syncs the whole thread and only ever appends), so
 * this is pure DOM windowing — no prepend/`firstItemIndex` paging is needed.
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
  /**
   * Staged actions for the live run awaiting the user's decision. Rendered
   * inline at the tail of the streaming turn, right under the tool trail whose
   * action they gate (ChatApprovalTray). Empty once every row is decided — the
   * rows disappear the moment a decision syncs out, so the cards clear with
   * them, and stay up while any remain pending in a multi-step approval.
   */
  approvals?: readonly SyncedActionStaging[];
}) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // The raw Virtuoso scroller element, captured via `scrollerRef`. The live
  // reply streams into the list *Footer* (not a data row); Virtuoso's own
  // `autoscrollToBottom` is gated by `atBottomThreshold`, so it ignores the
  // small per-drip growth and only nudges once the gap crosses the threshold —
  // leaving the newest text streaming in just below the fold ("the chat doesn't
  // go down as the response streams in"). Pinning this element straight to
  // `scrollHeight` each drip follows the footer exactly, with no threshold lag.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // The streaming footer's outer element and a ResizeObserver over it. The pin
  // effect below only fires on React `[messages, stream]` updates, but the footer
  // also grows *asynchronously* between updates — the tool trail's auto-animate
  // slides rows in, the accordion expands, markdown reflows as code/images
  // render. A one-shot pin then lands against the pre-growth height, leaving the
  // newest content below the fold (reads as "autoscroll stopped") and crammed
  // against the composer (the footer's bottom padding scrolled out of view). The
  // observer re-pins through that async growth; it fires only on real box changes
  // (no polling, no forced reflow), routing through the same coalesced pin.
  const footerElRef = useRef<HTMLElement | null>(null);
  const footerResizeRef = useRef<ResizeObserver | null>(null);
  const stickRef = useRef(true);
  // Bottom-most mounted row index, so a jump can pick smooth (the live edge is
  // near, animating through it reads as "catching up") over instant (the edge
  // is hundreds of unmeasured rows away — a smooth scroll would animate toward a
  // guessed height and stall partway, never reaching the bottom).
  const lastRenderedIndexRef = useRef(0);
  // Body of the just-finished stream, so its copy button can lift the rendered
  // HTML before the durable copy syncs in and takes over (see the footer).
  const streamBodyRef = useRef<HTMLDivElement | null>(null);
  // Drives the floating "scroll to latest" button — shown only while the user
  // has scrolled up off the live edge.
  const [showJump, setShowJump] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const showStream = shouldShowStream(messages, stream);

  // Attachments for this thread, grouped by message id (ADR-0065). One
  // subscription for the whole feed; each row looks up its own.
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

  // Per-row data handed to Virtuoso's `context`. Stable between durable updates
  // (it does not carry the streaming snapshot), so windowed rows stay memoized
  // and do not re-render on every streaming frame — only the footer does.
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
  // While a turn is in flight the viewport rides the bottom so the newest
  // activity — reasoning, the tool group's current step, the reply text —
  // stays in view without the user touching the scrollbar. Scrolling up to
  // read history detaches it (see `onAtBottomChange`); sending a new message
  // re-engages it so the next turn follows from the start.
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "user") return m.id;
    }
    return null;
  }, [messages]);
  // Re-engage stick-to-bottom when the user sends a new message (the last
  // user-message id changes) — even if they had scrolled up to read history.
  // `followOutput`/`autoscrollToBottom` only pin when already near the bottom,
  // so from far up we jump explicitly to the live edge. Skip the mount run
  // (`initialTopMostItemIndex` + the thread-switch effect already open at the
  // edge); this fires only on genuinely new user turns after that. An assistant
  // message landing while detached is not a user turn, so it never yanks.
  //
  // The jump-button reset is a state-on-prop-change, so it happens inline during
  // render via a prev-id compare — routing it through the effect would leave the
  // stale button up for a frame. The effect below only does the imperative jump.
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

  // Re-attach when the viewport returns to the bottom. Detach is driven by
  // `releasePin` below, not here: the streaming pin re-writes `scrollTop` every
  // drip, so by the time Virtuoso re-evaluates `atBottom` the pin has already
  // yanked us back — this callback would never see the scroll-up. It still
  // handles the re-attach edge (returning to the bottom flips `atBottom` true)
  // and keeps the jump button in sync with a genuine bottom arrival.
  const onAtBottomChange = useCallback((atBottom: boolean) => {
    if (atBottom) {
      stickRef.current = true;
      setShowJump(false);
    }
  }, []);

  // Release the pin the instant the user tries to scroll up. We detect the
  // *intent* (a wheel-up or a touch drag) rather than a scroll-position delta:
  // the pin re-writes `scrollTop` every drip, so any position-based check either
  // loses the race to the next pin or misses a slow drag whose per-event steps
  // never accumulate. Intent fires ahead of the pin and needs no accumulation.
  // Downward wheels are ignored — at the live edge there's nowhere further down,
  // and this must not fight the feed's own downward pins. Re-attach (returning
  // to the bottom) is handled by `onAtBottomChange`.
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

  // Capture the scroller element and own its input listeners. Stable identity so
  // Virtuoso doesn't tear the listeners down and rebuild them every render.
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

  // Follow the live edge as the footer's streaming bubble grows. `stream` is a
  // fresh snapshot each drip tick, so this fires per frame during a turn and on
  // each new durable message. The footer is fully rendered (not a virtualized
  // row), so its height is exact in the DOM — pinning the scroller straight to
  // its bottom rides the newest text with zero lag. `autoscrollToBottom` alone
  // can't: it's gated by `atBottomThreshold`, so it skips the small per-drip
  // growth and only jerks the view down once the gap exceeds the threshold,
  // leaving the live text below the fold. We still call it afterward — it's a
  // no-op while pinned, but for a freshly appended durable row whose height
  // Virtuoso hasn't measured yet it supplies the measurement-aware scroll a raw
  // `scrollTop` would land short of.
  //
  // The `scrollHeight` read + `scrollTop` write are deferred into one rAF rather
  // than run inline in the effect. Running inline reads layout immediately after
  // React's commit mutated the footer, forcing a synchronous reflow every drip
  // (a ~1.1s ForcedReflow window in the streaming trace). Coalescing into a
  // single rAF means at most one read+write per frame no matter how many drips
  // land, and the read happens at the frame's natural layout point — the pending
  // rAF always reads the *live* `scrollHeight`, so a burst still lands at the
  // true bottom.
  const pinRafRef = useRef<number | null>(null);
  const schedulePin = useCallback(() => {
    if (!stickRef.current) return;
    if (pinRafRef.current != null) return; // one pin per frame — coalesce the burst
    pinRafRef.current = requestAnimationFrame(() => {
      pinRafRef.current = null;
      if (!stickRef.current) return; // user scrolled up before the frame ran
      const el = scrollerElRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      virtuosoRef.current?.autoscrollToBottom();
    });
  }, []);
  useEffect(() => {
    schedulePin();
  }, [messages, stream, schedulePin]);

  // Re-pin on *asynchronous* footer growth the effect above can't see. A React
  // `[messages, stream]` update fires once per streamed snapshot, but the footer
  // keeps growing between snapshots: the tool trail's auto-animate slides rows
  // in, the accordion expands, markdown reflows as code/images finish rendering.
  // Observing the footer's box catches every such change (and only real ones —
  // no polling).
  //
  // The pin here is *synchronous*, not deferred through the rAF above: a
  // ResizeObserver callback runs after the browser's layout pass, so `scrollHeight`
  // is already computed (a cheap read, no forced reflow) and the `scrollTop` write
  // lands before paint — the frame of lag a rAF would add is exactly what left the
  // view trailing the growing trail by ~30px through every animation window.
  // Writing `scrollTop` doesn't change the observed box's size, so it can't
  // re-trigger the observer (no feedback loop). The observer target is swapped
  // live by `setFooterEl` as the footer mounts/unmounts across turns.
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
  // Cancel any pending pin on unmount (the coalescing guard means the effect
  // above never returns a per-run cleanup — that would cancel the burst's pin
  // before it fires).
  useEffect(
    () => () => {
      if (pinRafRef.current != null) cancelAnimationFrame(pinRafRef.current);
    },
    [],
  );

  // Jump back to the live edge and re-engage stick-to-bottom. `scrollToIndex` is
  // measurement-aware — it re-targets as it mounts unmeasured rows, so it lands
  // exactly at the bottom (a raw `scrollTo(scrollHeight)` chases an estimated
  // height and stalls partway). Smooth reads as "catching up" but can only
  // animate through already-measured rows, so it's used only when the live edge
  // is close; from far up (or under reduced motion) the jump is instant so it
  // reliably reaches the bottom. If a turn is streaming, stick-to-bottom then
  // rides the footer into view on the next drip tick.
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

  // The finish toast's "Open" action jumps back to the live edge — useful when
  // the user had scrolled up before the away-reply landed.
  const onScrollRequest = useEffectEvent(() => jumpToBottom());
  useEffect(() => {
    const handler = () => onScrollRequest();
    window.addEventListener(SCROLL_CHAT_TO_BOTTOM_EVENT, handler);
    return () => window.removeEventListener(SCROLL_CHAT_TO_BOTTOM_EVENT, handler);
  }, []);

  // Re-land at the bottom when the user switches threads. The component stays
  // mounted across `/chat/$threadId` navigations (only `messages` swaps), so
  // `initialTopMostItemIndex` — which applies once on mount — can't do it. As
  // above, the jump-button reset is a state-on-prop-change done inline during
  // render (a prev-id compare); the effect just performs the imperative jump.
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

  // Open at the live edge. Virtuoso reads this once on mount, so a lazy initial
  // state (rather than a memo over `messages`) captures the initial count
  // without re-computing as the thread grows. Thread switches are re-landed by
  // the `threadId` effect above.
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
  onRetry?: (
    text: string,
    retryAttachmentIds?: string[],
    retryAttachmentMessageId?: string,
  ) => void;
  onOpenArtifact?: (artifactId: string) => void;
  openArtifactId?: string | null;
}

const computeItemKey = (_: number, message: SyncedChatMessage) => message.id;

const renderItem = (index: number, message: SyncedChatMessage, context: FeedItemContext) => (
  <FeedRow index={index} message={message} context={context} />
);

/**
 * One durable message and any artifact trigger cards it authored. Memoized on
 * message identity so streaming re-renders (which change only the footer) leave
 * the windowed rows untouched. The `pb-5` replaces the feed's old inter-row
 * `gap-5`, since virtualized items stack with no gap of their own.
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
// Stable module-level component set so Virtuoso never remounts the chrome.
// The footer reads the live streaming snapshot from React context, keeping it
// out of Virtuoso's `context` (which would re-render every windowed row per
// streaming frame).

interface FeedFooterValue {
  showStream: boolean;
  stream: StreamingMessage | null;
  streamTimingRefs: StreamRenderTiming;
  streamBodyRef: React.RefObject<HTMLDivElement | null>;
  followUps: ReadonlyArray<FollowUpSuggestion>;
  onFollowUp?: (text: string) => void;
  approvals: readonly SyncedActionStaging[];
  /** Registers the footer's outer element with the parent's re-pin observer. */
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
  // Order the pending approvals to match the tool trail above, so each card sits
  // under the call it gates. Approvals whose tool card isn't in the live stream
  // (e.g. a cold reload that missed the transient `started` event) fall to the
  // end in `createdAt` order.
  const orderedApprovals = orderApprovalsByTool(approvals, stream);
  return (
    // Match FeedList's column: Virtuoso renders the Footer as a *sibling* of the
    // List (not a child), so without this the streaming bubble spans the full
    // viewport width and then snaps into the padded column the instant the
    // durable message syncs in as a list row. `setFooterEl` registers this
    // element with the parent's re-pin observer so async footer growth (the tool
    // trail auto-animating, markdown reflow) keeps riding the live edge.
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

          {stream.tools.length > 0 ? (
            <ToolCallGroup
              tools={stream.tools}
              narration={stream.narration}
              active={!stream.done}
            />
          ) : null}

          {/* The action(s) a gated run is parked on, inline right under the tool
           * trail that proposed them. The tray no-ops when there's nothing to
           * decide. */}
          <ChatApprovalTray
            runId={stream.runId}
            approvals={orderedApprovals}
            awaitingApproval={stream.awaitingApproval}
          />

          {stream.compacting ? <ThinkingIndicator label="Condensing conversation…" /> : null}

          {stream.text.length > 0 ? (
            <div ref={streamBodyRef}>
              <div ref={streamTimingRefs.text}>
                <AssistantMarkdown text={stream.text} streaming={!stream.done} />
              </div>
            </div>
          ) : stream.tools.length === 0 &&
            stream.reasoning.length === 0 &&
            !stream.reasoningActive &&
            !stream.compacting ? (
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
 * Floating jump-to-latest control, doubling as a live-activity pill. Appears
 * only when the user has scrolled up off the live edge; clicking re-attaches
 * stick-to-bottom. While a turn is streaming it widens into a pill that names
 * the current step ("Checking your calendar…", "Responding…") behind a breathing
 * Alfred mark, so a user reading history still sees what Alfred is doing without
 * scrolling back down. With no turn in flight it stays the quiet round arrow.
 * Borrowed from dimension's chat, whose long threads surface the same affordance.
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
    // A centered non-interactive band so the pill can grow/shrink around its
    // midpoint; only the button itself takes pointer events.
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

/**
 * Orders pending approvals to match the live tool trail so each decision card
 * sits under the call it gates. Any approval whose tool card isn't in the stream
 * (a cold reload that missed the transient `started` event) sorts after the
 * matched ones, by `createdAt`.
 */
function orderApprovalsByTool(
  approvals: readonly SyncedActionStaging[],
  stream: StreamingMessage | null,
): readonly SyncedActionStaging[] {
  if (approvals.length <= 1) return approvals;
  const toolOrder = new Map<string, number>();
  stream?.tools.forEach((tool, i) => toolOrder.set(tool.toolCallId, i));
  return [...approvals].sort((a, b) => {
    const ia = toolOrder.get(a.toolCallId) ?? Number.POSITIVE_INFINITY;
    const ib = toolOrder.get(b.toolCallId) ?? Number.POSITIVE_INFINITY;
    if (ia !== ib) return ia - ib;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Tracks the user's reduced-motion preference reactively (SSR-safe). Used to
 * turn the jump-to-latest scroll animation into an instant jump.
 */
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
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
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
      {/* Branded pulsing mark in place of a generic spinner — the Alfred glyph
       * breathes inside a soft halo while the turn spins up. Mirrors
       * dimension's pulsing AI icon to the left of its working state. */}
      <span className="chat-think-mark inline-flex shrink-0">
        <img src="/images/logo/alfred-logo.svg" alt="" className="size-[18px] rounded-[5px]" />
      </span>
      <span className="animate-chat-shimmer">{label}</span>
    </div>
  );
}
