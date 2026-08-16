/**
 * Shared metadata helpers for runtime observation spans (#414, PRD #405).
 *
 * These two utilities describe a runtime span's payload rather than open one:
 * a coarse latency health band and a bounded tool-name list. Both the agent
 * orchestration spans (`packages/assistant` agent/runtime-spans) and the tool-runtime
 * spans (`packages/assistant` tool-runtime/internal/runtime-spans) build their span
 * metadata from them, so they live beside the `startRuntimeSpan` owner in
 * `@alfred/ai`. One owner keeps the two span families from drifting on the
 * threshold edges or the name-list cap. Mirrors PR #633, which gave schema
 * token estimation a single shared owner in this package.
 *
 * Pure and side-effect free so a test pins the exact band edges and the cap —
 * the whole point of a debug threshold is that it can drift silently unless
 * something asserts it.
 */

/** Coarse health band for a measured latency. */
export type LatencyHealth = "ok" | "yellow" | "red";

interface LatencyThreshold {
  /** Strictly above this (ms) degrades from ok to yellow. */
  yellowMs: number;
  /** Strictly above this (ms) degrades from yellow to red. */
  redMs: number;
}

/**
 * Default debug thresholds for the lazy-tool spans (PRD "Implementation
 * Decisions"): tool search yellow >25ms / red >100ms; schema rebuild yellow
 * >50ms / red >200ms. Frozen so a consumer can read but never mutate them.
 */
export const RUNTIME_LATENCY_THRESHOLDS = Object.freeze({
  tool_search: { yellowMs: 25, redMs: 100 },
  schema_rebuild: { yellowMs: 50, redMs: 200 },
} satisfies Record<string, LatencyThreshold>);

export type RuntimeLatencyKind = keyof typeof RUNTIME_LATENCY_THRESHOLDS;

/**
 * Classify a measured latency (ms) into its debug band. The PRD phrases both
 * edges as "above" (strictly greater), so a latency sitting exactly on an edge
 * stays in the lower, healthier band.
 */
export function classifyLatency(kind: RuntimeLatencyKind, ms: number): LatencyHealth {
  const threshold = RUNTIME_LATENCY_THRESHOLDS[kind];
  if (ms > threshold.redMs) return "red";
  if (ms > threshold.yellowMs) return "yellow";
  return "ok";
}

/**
 * Cap a joined tool-name list so span metadata stays bounded — the single owner
 * of that rule. Every runtime span that emits a tool-name list (preload,
 * surface, search) routes through this, so an unbounded `join(",")` can't leak
 * back into span metadata one closer at a time. Returns null for an empty list
 * so a "no names" span reads as absent rather than an empty string.
 */
export function boundedNameList(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const joined = names.join(",");
  return joined.length <= 800 ? joined : `${joined.slice(0, 797)}...`;
}
