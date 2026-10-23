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
 * The live-with-no-new-user-row path fires only when the last Virtuoso row is a
 * user row. Roles are only `user | assistant` (`packages/db/src/schema/chat.ts`),
 * and the durable assistant row joins the list only at run end (every
 * `chat-turn-closure.ts` ending writes one: completed and cancelled write
 * `complete`, failed writes `failed`; a close that yields to cancel runs only
 * because the cancel already wrote its row). So a just-seeded stream whose user
 * row is still in flight (`seedChatStream` runs before `chatMessageCreate`)
 * sees the previous turn's assistant row last and anchors nothing here; the
 * arriving user row takes the `send` path. A live run that owns the current
 * last user row (mount or resume onto a live run, an approval or `ask_user`
 * wake) anchors `open`. A user row with no live stream (a send whose request
 * failed before the run started) never anchors: there is no reply coming.
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

  // The durable assistant row joins the list only at run end, so while a run
  // is live its user row is the last row. A just-seeded stream whose user row
  // is still in flight still ends in the previous turn's assistant row.
  const lastRowIsUser = (messages.at(-1)?.role ?? null) === "user";

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
  } else if (live && lastRowIsUser && lastUserId && anchor?.id !== lastUserId) {
    // A live run owns the current last row: a mount or resume the switch saw
    // no stream for yet, or a wake with no new user row. This never fires for
    // a just-seeded stream (its user row has not arrived, so the last row is
    // still the previous turn's assistant row), and it does not count
    // renders: a during-render `setPrev` re-runs the component in the same
    // pass, so key equality can never mean "stable across renders".
    setPrev({ threadId, lastUserId });
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

  const applyFooterReserve = useCallback(
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

      if (prev && prev !== el) applyFooterReserve(prev, false);

      swapObserved(footerElRef, el);
      applyFooterReserve(el, anchorRef.current !== null);
    },
    [swapObserved, applyFooterReserve],
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
      applyFooterReserve(footerElRef.current, false);

      return;
    }

    // Over-reserve first (a zero tail holds the full reading area minus the gap),
    // so the anchor target stays reachable while the row renders; the measure then
    // sizes the tail exactly once the row is there. On mount there is no scroll
    // (Virtuoso's initial location lands it); the over-reserve keeps that landing
    // reachable too. A refine never makes the target unreachable: rows plus footer
    // stay at the reading area minus the gap.
    applyFooterReserve(footerElRef.current, true);
    writeTail(0);
    measure();

    if (anchor.kind !== "mount") scrollToAnchor(anchor);
  }, [anchor, measure, applyFooterReserve, writeTail]);

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
