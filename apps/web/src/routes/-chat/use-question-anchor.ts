import type { SyncedChatMessage } from "@alfred/sync";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { IndexLocationWithAlign, VirtuosoHandle } from "react-virtuoso";

/** Space above an anchored question. Matches `FeedHeader` (`h-6`), so it sits where a first message sits. */
const ANCHOR_GAP_PX = 24;

/** The pill shows when the live end is more than this far below the fold. */
const AT_BOTTOM_PX = 80;

/**
 * Written on the footer content box; the only number JS owns. The footer
 * `min-height` reads it against the reading area (`100cqh`, below), so a
 * composer or window resize lands in the same layout instead of clamping
 * `scrollTop` for one frame before a `ResizeObserver` can react.
 */
const TAIL_VAR = "--rows-tail";

/** `container-type` property put on the Virtuoso scroller (removed on detach). */
const SCROLLER_CONTAINER_TYPE = "size";

const CONTAINER_TYPE_PROP = "container-type";

/**
 * The footer reserve. `100cqh` is the scroller height (the scroller is the
 * query container), so JS never reads `clientHeight` for the reserve.
 * Virtuoso reads its viewport through `offsetHeight` (`dist/index.mjs:2374`),
 * which size containment leaves unchanged: the flex layout sizes the
 * scroller, never its contents. `scroll-stable` (`scrollbar-gutter`) is
 * orthogonal to containment.
 */
const RESERVE_MIN_HEIGHT = `max(0px, calc(100cqh - ${ANCHOR_GAP_PX}px - var(${TAIL_VAR}, 0px)))`;

/** The feed row attribute that carries the message id. The hook finds the anchored row by it. */
export const MESSAGE_ID_ATTR = "data-message-id";

/**
 * The user message the feed holds at the top of the viewport.
 * `send`: a new message (here or on another device), smooth when near.
 * `open`: a thread switch or resume onto a live run, instant.
 * `mount`: live at mount; Virtuoso's initial location lands it, so no scroll.
 */
interface Anchor {
  id: string;
  kind: "send" | "open" | "mount";
}

/** What the feed reads from `useQuestionAnchor`. */
interface QuestionAnchor {
  /** Virtuoso `scrollerRef`. Adds the passive `scroll` listener and observes the scroller. */
  attachScroller: (ref: HTMLElement | Window | null) => void;
  /** The scroller, for the approval tray IntersectionObserver root. */
  scrollerElRef: React.RefObject<HTMLElement | null>;
  /** The feed list element (the rows tail). */
  setListEl: (el: HTMLElement | null) => void;
  /** The footer content box: gets the reserve, observed for the pill. */
  setFooterEl: (el: HTMLElement | null) => void;
  /** True while the live end is more than `AT_BOTTOM_PX` below the fold. */
  belowFold: boolean;
  /** True while a turn is anchored; a thread switch then skips the bottom landing. */
  anchored: boolean;
  /** Virtuoso `initialTopMostItemIndex`, read once on mount. */
  initialLocation: IndexLocationWithAlign;
}

/**
 * Question-at-top scroll for the chat feed (Dimension's model).
 *
 * A turn anchors to its user message: the question moves to the top of the viewport one
 * time, and the reply grows into reserved space below it. Nothing writes `scrollTop`
 * during the turn, so the text does not move under the reader. The anchor stays after
 * the run ends, until the next send or a thread switch, so the view does not move at
 * the end of the turn either.
 *
 * The reserve is a `min-height` the hook writes on the footer content box, sized
 * from the rows only: the browser keeps `rowsTail + (100cqh - gap - rowsTail)`
 * at the reading area minus the gap, so every footer shrink (spinner out,
 * trail collapse, the stream-to-durable handoff) and every reading-area change
 * (composer clear, tray shrink, window resize) lands in the same layout. A
 * `ResizeObserver` runs after layout, which is too late: the browser clamps
 * `scrollTop` in layout.
 *
 * Branch 3 (live with no new user row) keys off the stream's own turn
 * identity: it fires only once the live `runId` is stable across renders, so
 * a just-seeded stream whose user row is still in flight never anchors the
 * previous question. A live run that belongs to the current last user row
 * (mount or resume onto a live run, an approval or `ask_user` wake) anchors
 * `open` on the first stable render.
 */
export function useQuestionAnchor({
  virtuosoRef,
  messages,
  threadId,
  live,
  liveKey,
  smoothAnchor,
}: {
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  messages: readonly SyncedChatMessage[];
  threadId: string | undefined;
  /** `showStream && !stream.done`. */
  live: boolean;
  /** The live turn's identity (`stream.runId`) while `live`, else `null`. */
  liveKey: string | null;
  /** `!reducedMotion && isNearLiveEdge()`, read at anchor time. */
  smoothAnchor: () => boolean;
}): QuestionAnchor {
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];

      if (message && message.role === "user") return message.id;
    }

    return null;
  }, [messages]);

  // ---- The anchor, derived during render ------------------------------
  const [anchor, setAnchor] = useState<Anchor | null>(() =>
    live && lastUserId ? { id: lastUserId, kind: "mount" } : null,
  );

  const [prev, setPrev] = useState({ threadId, lastUserId, liveKey });

  if (threadId !== prev.threadId) {
    setPrev({ threadId, lastUserId, liveKey });
    setAnchor(live && lastUserId ? { id: lastUserId, kind: "open" } : null);
  } else if (lastUserId !== prev.lastUserId) {
    setPrev({ threadId, lastUserId, liveKey });

    if (lastUserId) setAnchor({ id: lastUserId, kind: "send" });
  } else if (
    live &&
    liveKey !== null &&
    liveKey === prev.liveKey &&
    lastUserId &&
    anchor?.id !== lastUserId
  ) {
    // A live run for the current last user row: a mount or resume the switch
    // saw no stream for yet, or a wake with no new user row. The key must be
    // stable across renders, so a just-seeded stream whose user row is still
    // in flight (`seedChatStream` runs before `chatMessageCreate`) never
    // anchors the previous question here; its user row takes the `send` path.
    setPrev({ threadId, lastUserId, liveKey });
    setAnchor({ id: lastUserId, kind: "open" });
  } else if (liveKey !== prev.liveKey) {
    setPrev({ threadId, lastUserId, liveKey });
  }

  // Virtuoso reads this once on mount. Later landings go through `scrollToIndex`.
  const [initialLocation] = useState<IndexLocationWithAlign>(() => {
    const index = anchor ? messages.findIndex((m) => m.id === anchor.id) : -1;

    return index >= 0
      ? { index, align: "start", offset: -ANCHOR_GAP_PX }
      : { index: Math.max(0, messages.length - 1), align: "end" };
  });

  // ---- Elements, the reserve, and the pill ----------------------------
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const listElRef = useRef<HTMLElement | null>(null);
  const footerElRef = useRef<HTMLElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const anchorRef = useRef<Anchor | null>(null);
  // The rows tail in px, or `null` for none. Kept so a new footer element gets it too.
  const tailRef = useRef<number | null>(null);
  // False until the reserve was sized from the rendered anchored row.
  const exactRef = useRef(false);
  const [belowFold, setBelowFold] = useState(false);

  // The hook owns every style it depends on: the footer `min-height` formula
  // and the rows-tail variable (here), and the scroller `container-type`
  // (in `attachScroller`). No string literal in another file reads them.
  const writeTail = useCallback((px: number | null) => {
    tailRef.current = px;
    const footer = footerElRef.current;

    if (!footer) return;

    if (px === null) footer.style.removeProperty(TAIL_VAR);
    else footer.style.setProperty(TAIL_VAR, `${px}px`);
  }, []);

  const syncFooterChrome = useCallback(
    (el: HTMLElement | null, anchored: boolean) => {
      if (!el) return;

      if (anchored) {
        el.style.minHeight = RESERVE_MIN_HEIGHT;
        writeTail(tailRef.current);
      } else {
        el.style.minHeight = "";
        el.style.removeProperty(TAIL_VAR);
      }
    },
    [writeTail],
  );

  const readBelowFold = useCallback(() => {
    const el = scrollerElRef.current;

    if (el) setBelowFold(el.scrollHeight - el.scrollTop - el.clientHeight > AT_BOTTOM_PX);
  }, []);

  // Size the rows tail when the anchored row is rendered; else keep the provisional
  // zero (an over-reserve: the footer then holds the full reading area minus the gap).
  // A rect difference, so it does not depend on `scrollTop`.
  const measure = useCallback(() => {
    const scroller = scrollerElRef.current;
    const list = listElRef.current;
    const current = anchorRef.current;

    if (scroller && list && current) {
      const row = scroller.querySelector(`[${MESSAGE_ID_ATTR}="${CSS.escape(current.id)}"]`);

      if (row) {
        const rowsTail = list.getBoundingClientRect().bottom - row.getBoundingClientRect().top;
        writeTail(Math.max(0, rowsTail));
        exactRef.current = true;
      }
    }

    readBelowFold();
  }, [writeTail, readBelowFold]);

  // Refine a provisional reserve on the first scroll after the anchored row renders.
  // A row that renders with no size change in the list fires no resize.
  const onScroll = useCallback(() => {
    if (anchorRef.current && !exactRef.current) measure();
    else readBelowFold();
  }, [measure, readBelowFold]);

  // One observer over the scroller (reading area), the list (rows), and the footer (pill).
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(measure);
    observerRef.current = ro;

    for (const el of [scrollerElRef.current, listElRef.current, footerElRef.current]) {
      if (el) ro.observe(el);
    }

    return () => {
      ro.disconnect();
      observerRef.current = null;
    };
  }, [measure]);

  const swapObserved = useCallback(
    (ref: React.RefObject<HTMLElement | null>, el: HTMLElement | null) => {
      if (ref.current === el) return;
      const ro = observerRef.current;

      if (ro && ref.current) ro.unobserve(ref.current);
      ref.current = el;

      if (ro && el) ro.observe(el);
    },
    [],
  );

  // Stable identity, so Virtuoso does not rebuild the listener each render.
  const attachScroller = useCallback(
    (ref: HTMLElement | Window | null) => {
      scrollerElRef.current?.removeEventListener("scroll", onScroll);
      const el = ref instanceof HTMLElement ? ref : null;
      const prev = scrollerElRef.current;
      prev?.style.removeProperty(CONTAINER_TYPE_PROP);
      swapObserved(scrollerElRef, el);
      el?.style.setProperty(CONTAINER_TYPE_PROP, SCROLLER_CONTAINER_TYPE);
      el?.addEventListener("scroll", onScroll, { passive: true });
    },
    [onScroll, swapObserved],
  );

  const setListEl = useCallback(
    (el: HTMLElement | null) => swapObserved(listElRef, el),
    [swapObserved],
  );

  const setFooterEl = useCallback(
    (el: HTMLElement | null) => {
      const prev = footerElRef.current;

      if (prev && prev !== el) {
        prev.style.minHeight = "";
        prev.style.removeProperty(TAIL_VAR);
      }

      swapObserved(footerElRef, el);
      syncFooterChrome(el, anchorRef.current !== null);
    },
    [swapObserved, syncFooterChrome],
  );

  // ---- The anchor scroll, once per anchor event -----------------------
  const scrollToAnchor = useEffectEvent((next: Anchor) => {
    const index = messages.findIndex((m) => m.id === next.id);

    if (index < 0) return;
    virtuosoRef.current?.scrollToIndex({
      index,
      align: "start",
      offset: -ANCHOR_GAP_PX,
      behavior: next.kind === "send" && smoothAnchor() ? "smooth" : "auto",
    });
  });

  useLayoutEffect(() => {
    anchorRef.current = anchor;
    exactRef.current = false;

    if (!anchor) {
      tailRef.current = null;
      const footer = footerElRef.current;

      if (footer) {
        footer.style.minHeight = "";
        footer.style.removeProperty(TAIL_VAR);
      }

      return;
    }

    // Over-reserve first (a zero tail holds the full reading area minus the gap),
    // so the target is reachable before the row renders; the measure then sizes
    // the tail exactly when the row is already there. A refine never makes the
    // target unreachable: rows plus footer stay at the reading area minus the gap.
    syncFooterChrome(footerElRef.current, true);
    writeTail(0);
    measure();

    if (anchor.kind !== "mount") scrollToAnchor(anchor);
  }, [anchor, measure, syncFooterChrome, writeTail]);

  return {
    attachScroller,
    scrollerElRef,
    setListEl,
    setFooterEl,
    belowFold,
    anchored: anchor !== null,
    initialLocation,
  };
}
