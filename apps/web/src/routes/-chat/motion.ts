import type { Transition } from "motion/react";
import { useSyncExternalStore } from "react";

/**
 * Live reduced-motion preference, SSR-safe. Motion's own `reducedMotion="user"`
 * check runs once per element mount, so a long-lived element (the thread-long
 * `ActivityPill`, the turn-long chip row) must read this live hook instead for
 * any size key it tweens. Motion already makes transform and positional keys
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

/** Same curve as the chat keyframes in index.css (`cubic-bezier(0.22, 1, 0.36, 1)`). */
const CHAT_EASE = [0.22, 1, 0.36, 1] as const;

/** A state swap: tool label, activity text. */
export const CHAT_SWAP = { duration: 0.2, ease: CHAT_EASE } as const satisfies Transition;

/** A small element leaves or arrives: chips, pills, glyphs. */
export const CHAT_POP = { duration: 0.15, ease: CHAT_EASE } as const satisfies Transition;
