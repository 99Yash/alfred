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

/** Written on the footer content box, read by its `min-height`. */
const RESERVE_VAR = "--feed-reserve";

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
 * The reserve is CSS `min-height` on the footer content box, sized from the rows only
 * (`clientHeight - ANCHOR_GAP_PX - rowsTail`, where `rowsTail` is the anchored row top to
 * the list bottom). It does not depend on the footer content, so the browser absorbs
 * every footer shrink (spinner out, trail collapse, the stream-to-durable handoff) in the
 * same layout. A `ResizeObserver` runs after layout, which is too late: the browser
 * clamps `scrollTop` in layout.
 */
export function useQuestionAnchor({
  virtuosoRef,
  messages,
  threadId,
  live,
  smoothAnchor,
}: {
  virtuosoRef: React.RefObject<VirtuosoHandle | null>;
  messages: readonly SyncedChatMessage[];
  threadId: string | undefined;
  /** `showStream && !stream.done`. */
  live: boolean;
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

  const [prev, setPrev] = useState({ threadId, lastUserId });

  if (threadId !== prev.threadId) {
    setPrev({ threadId, lastUserId });
    setAnchor(live && lastUserId ? { id: lastUserId, kind: "open" } : null);
  } else if (lastUserId !== prev.lastUserId) {
    setPrev({ threadId, lastUserId });

    if (lastUserId) setAnchor({ id: lastUserId, kind: "send" });
  } else if (live && lastUserId && anchor?.id !== lastUserId) {
    // A live run found after a switch or on resume: the switch saw no stream yet.
    setAnchor({ id: lastUserId, kind: "open" });
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
  // The reserve in px, or `null` for none. Kept so a new footer element gets it too.
  const reserveRef = useRef<number | null>(null);
  // False until the reserve was sized from the rendered anchored row.
  const exactRef = useRef(false);
  const [belowFold, setBelowFold] = useState(false);

  const writeReserve = useCallback((px: number | null) => {
    reserveRef.current = px;
    const footer = footerElRef.current;

    if (!footer) return;

    if (px === null) footer.style.removeProperty(RESERVE_VAR);
    else footer.style.setProperty(RESERVE_VAR, `${px}px`);
  }, []);

  const readBelowFold = useCallback(() => {
    const el = scrollerElRef.current;

    if (el) setBelowFold(el.scrollHeight - el.scrollTop - el.clientHeight > AT_BOTTOM_PX);
  }, []);

  // Size the reserve from the rows when the anchored row is rendered; else keep the last value.
  // A rect difference, so it does not depend on `scrollTop`.
  const measure = useCallback(() => {
    const scroller = scrollerElRef.current;
    const list = listElRef.current;
    const current = anchorRef.current;

    if (scroller && list && current) {
      const row = scroller.querySelector(`[${MESSAGE_ID_ATTR}="${CSS.escape(current.id)}"]`);

      if (row) {
        const rowsTail = list.getBoundingClientRect().bottom - row.getBoundingClientRect().top;
        writeReserve(Math.max(0, scroller.clientHeight - ANCHOR_GAP_PX - rowsTail));
        exactRef.current = true;
      }
    }

    readBelowFold();
  }, [writeReserve, readBelowFold]);

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
      swapObserved(scrollerElRef, el);
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
      swapObserved(footerElRef, el);
      writeReserve(reserveRef.current);
    },
    [swapObserved, writeReserve],
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
      writeReserve(null);

      return;
    }

    // Over-reserve first, so the target is reachable before the row renders; the
    // measure then sizes it exactly when the row is already there.
    const scroller = scrollerElRef.current;

    if (scroller) writeReserve(Math.max(0, scroller.clientHeight - ANCHOR_GAP_PX));
    measure();

    if (anchor.kind !== "mount") scrollToAnchor(anchor);
  }, [anchor, measure, writeReserve]);

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
