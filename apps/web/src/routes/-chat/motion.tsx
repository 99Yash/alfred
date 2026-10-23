import { AnimatePresence, m, useIsPresent } from "motion/react";
import type { TargetAndTransition, Transition } from "motion/react";
import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

/**
 * Live reduced-motion preference, SSR-safe. Motion's own `reducedMotion="user"`
 * check runs once per element mount, so a long-lived element (the thread-long
 * `ActivityPill`, the turn-long chip row, the slot-long rail and artifact panel)
 * must read this live hook AND pass `reduceMotion` in its transition. The hook
 * alone only changes the call-site ternary: motion still applies its mount-time
 * snapshot to positional keys (`width`, `height`, `x`) unless the transition
 * carries the live value. Motion already makes transform and positional keys
 * (`width`, `height`, `top`, `left`, `right`, `bottom`) instant at mount; a call
 * site gates what motion does not cover at mount (non-positional keys such as
 * `marginBottom`) and any tween on an element that outlives a reduce change.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => getReducedMotionSnapshot(),
    () => false,
  );
}

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  mql.addEventListener("change", onChange);

  return () => mql.removeEventListener("change", onChange);
}

function getReducedMotionSnapshot(): boolean {
  if (typeof window === "undefined") return false;

  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A `Transition` that also carries the live reduced-motion value. Motion 14.6
 * reads `transition.reduceMotion` per animation start, but its `Transition`
 * type omits the field, so call sites annotate with this instead of casting.
 * Pass `reduceMotion` from `usePrefersReducedMotion()`: motion otherwise keeps
 * its mount-time snapshot for positional keys (`width`, `x`) on an element
 * that outlives a reduce change.
 */
export type LiveTransition = Transition & { reduceMotion?: boolean };

/** Same curve as the chat keyframes in index.css (`cubic-bezier(0.22, 1, 0.36, 1)`). */
const CHAT_EASE = [0.22, 1, 0.36, 1] as const;

/** A state swap: tool label, activity text. */
export const CHAT_SWAP = { duration: 0.2, ease: CHAT_EASE } as const satisfies Transition;

/** A small element leaves or arrives: chips, pills, glyphs. */
export const CHAT_POP = { duration: 0.15, ease: CHAT_EASE } as const satisfies Transition;

/**
 * A side panel slides in or out: the artifact sidebar and the inline Today rail.
 * Same curve as Dimension's sidebar. Both import this constant, so one clock
 * drives the swap.
 */
export const CHAT_PANEL = {
  duration: 0.45,
  ease: [0.32, 0.72, 0, 1],
} as const satisfies Transition;

type CollapseAxis = "height" | "width";

type CollapseItemTag = "div" | "li";

const CollapseListContext = createContext<{
  itemTag: CollapseItemTag;
  axis: CollapseAxis;
  reduce: boolean;
} | null>(null);

/**
 * The collapse behind {@link CollapseItem}: a fade plus a size collapse, so
 * the rows after a leaving row reflow smoothly with no `layout` feature
 * (`domMax`). File-local: call sites render `CollapseItem`, they never spread
 * this. The list reads reduce once and hands it down; rows (queued messages,
 * to-dos) outlive a preference change, so the transition carries the live
 * value. `overflow: hidden` holds only while the size tweens, so a settled
 * row does not clip a child's focus ring. `transitionEnd` alone does not do
 * that: after a size tween to `"auto"` the row keeps inline
 * `overflow: hidden` until its next render, so the item also clears the clip
 * in place (see `CollapseItem`).
 */
function collapseProps(axis: CollapseAxis, reduce: boolean) {
  const size = (value: 0 | "auto") => (axis === "height" ? { height: value } : { width: value });
  const collapsed: TargetAndTransition = { opacity: 0, ...size(0), overflow: "hidden" };

  return {
    initial: collapsed,
    animate: { opacity: 1, ...size("auto"), transitionEnd: { overflow: "visible" } },
    exit: collapsed,
    transition: { ...CHAT_POP, reduceMotion: reduce },
  } as const satisfies {
    initial: TargetAndTransition;
    animate: TargetAndTransition;
    exit: TargetAndTransition;
    transition: LiveTransition;
  };
}

/**
 * One row of a list that grows and shrinks (tool-trail rows, sub-agent
 * steps, queued messages, attachment chips, to-dos). The keyed `CollapseItem`
 * is the direct child of a `CollapseList`: its enter runs once on add, its
 * exit collapses its size, and while it leaves it is `inert`, so its buttons
 * take no pointer or keyboard input mid-exit. The list picks the tag, axis,
 * and reduce; the item sets `inert`. The row owns only its content: the
 * animated node takes no classes, so padding, borders, and `overflow-hidden`
 * go on an inner `div`. When the enter lands the item sets inline
 * `overflow: visible` directly on its node (a DOM write, not state, so no
 * re-render): a leaving row keeps `hidden` through its collapse, and a
 * re-entered row re-applies `hidden` through its next tween.
 */
export function CollapseItem({ children }: { children: ReactNode }) {
  const list = useContext(CollapseListContext);

  if (!list) throw new Error("CollapseItem must render inside a CollapseList");

  const motionProps = collapseProps(list.axis, list.reduce);
  const isPresent = useIsPresent();
  const rowRef = useRef<HTMLElement | null>(null);

  const setRowRef = useCallback((node: HTMLElement | null) => {
    rowRef.current = node;
  }, []);

  const clearClipOnSettle = useCallback(() => {
    rowRef.current?.style.setProperty("overflow", "visible");
  }, []);

  if (list.itemTag === "li") {
    return (
      <m.li
        {...motionProps}
        ref={setRowRef}
        inert={!isPresent}
        onAnimationComplete={clearClipOnSettle}
      >
        {children}
      </m.li>
    );
  }

  return (
    <m.div
      {...motionProps}
      ref={setRowRef}
      inert={!isPresent}
      onAnimationComplete={clearClipOnSettle}
    >
      {children}
    </m.div>
  );
}

/**
 * The list around keyed `CollapseItem` rows. Rows already present on the
 * first render do not animate (`initial={false}`): the list ignores rows
 * mounted with it. The `as` tag picks the row tag (`ol`/`ul` rows are `li`,
 * `div` rows are `div`); `axis` is `width` only for the fixed-size chip row.
 */
export function CollapseList({
  as = "div",
  axis = "height",
  className,
  children,
}: {
  as?: "div" | "ol" | "ul" | undefined;
  /** `height` for stacked rows, `width` for the fixed-size chip row. */
  axis?: CollapseAxis | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  const Container = as;
  const reduce = usePrefersReducedMotion();
  const itemTag: CollapseItemTag = as === "div" ? "div" : "li";

  return (
    <Container className={className}>
      <CollapseListContext.Provider value={{ itemTag, axis, reduce }}>
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </CollapseListContext.Provider>
    </Container>
  );
}
