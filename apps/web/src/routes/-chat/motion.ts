import type { Transition } from "motion/react";
import { useSyncExternalStore } from "react";

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
