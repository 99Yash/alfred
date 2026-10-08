import { z } from "zod";

/** Clamp a model number into [0, 1]. Use it where a threshold reads a confidence. */
export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * A model confidence, expected in [0, 1]. No `.min/.max`: the cheap model's
 * structured output rejects `minimum`/`maximum`. Clamp with {@link clamp01} where it matters.
 */
export const confidenceSchema = z.number();
