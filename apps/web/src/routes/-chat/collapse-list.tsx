import { AnimatePresence, m, useIsPresent } from "motion/react";
import type { TargetAndTransition } from "motion/react";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import { CHAT_POP, type LiveTransition, usePrefersReducedMotion } from "./motion";

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
 * row does not clip a child's focus ring. `overflow` sits in the `animate`
 * target on purpose: that gives it a motion value from the enter start, so
 * the `transitionEnd` write is a `.set()` that schedules a render. Without
 * that value, motion adds `overflow` through `addValue`, which schedules no
 * render, and a React render in the settle frame writes `hidden` back.
 */
function collapseProps(axis: CollapseAxis, reduce: boolean) {
  const size = (value: 0 | "auto") => (axis === "height" ? { height: value } : { width: value });
  const collapsed: TargetAndTransition = { opacity: 0, ...size(0), overflow: "hidden" };

  return {
    initial: collapsed,
    animate: {
      opacity: 1,
      ...size("auto"),
      overflow: "hidden",
      transitionEnd: { overflow: "visible" },
    },
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
 * go on an inner `div`.
 */
export function CollapseItem({ children }: { children: ReactNode }) {
  const list = useContext(CollapseListContext);

  if (!list) throw new Error("CollapseItem must render inside a CollapseList");

  const isPresent = useIsPresent();
  const rowProps = { ...collapseProps(list.axis, list.reduce), inert: !isPresent };

  if (list.itemTag === "li") return <m.li {...rowProps}>{children}</m.li>;

  return <m.div {...rowProps}>{children}</m.div>;
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
  const list = useMemo(() => ({ itemTag, axis, reduce }), [itemTag, axis, reduce]);

  return (
    <Container className={className}>
      <CollapseListContext.Provider value={list}>
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </CollapseListContext.Provider>
    </Container>
  );
}
