import type { Transition } from "motion/react";

/** Same curve as the chat keyframes in index.css (`cubic-bezier(0.22, 1, 0.36, 1)`). */
const CHAT_EASE = [0.22, 1, 0.36, 1] as const;

/** A state swap: tool label, activity text. */
export const CHAT_SWAP = { duration: 0.2, ease: CHAT_EASE } as const satisfies Transition;

/** A small element leaves or arrives: chips, pills, glyphs. */
export const CHAT_POP = { duration: 0.15, ease: CHAT_EASE } as const satisfies Transition;
