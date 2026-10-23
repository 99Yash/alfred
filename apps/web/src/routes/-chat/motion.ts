import type { Transition } from "motion/react";

/**
 * Reduced-motion contract: `MotionConfig reducedMotion="user"` (see root-layout)
 * makes transform and positional keys (`width`, `height`, `top`, `left`, `right`,
 * `bottom`) instant by itself, but that check runs once per element mount. A call
 * site must gate with the live `usePrefersReducedMotion()` hook in conversation.tsx
 * when it tweens a non-positional key (such as `marginBottom`) or when the element
 * outlives a reduce change (such as the thread-long `ActivityPill` width tween).
 */

/** Same curve as the chat keyframes in index.css (`cubic-bezier(0.22, 1, 0.36, 1)`). */
const CHAT_EASE = [0.22, 1, 0.36, 1] as const;

/** A state swap: tool label, activity text. */
export const CHAT_SWAP = { duration: 0.2, ease: CHAT_EASE } as const satisfies Transition;

/** A small element leaves or arrives: chips, pills, glyphs. */
export const CHAT_POP = { duration: 0.15, ease: CHAT_EASE } as const satisfies Transition;
