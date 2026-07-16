/**
 * Debug latency thresholds for lazy-tool runtime spans (#414, PRD #405).
 *
 * The PRD asks for lazy-tool lookup and schema-build time to be judged against
 * *default debug thresholds*, not hard product alerts: a span records the raw
 * latency plus a coarse health band an operator can filter on. These are the two
 * lazy-tool bands from the PRD's threshold table; the wait/queue/scratch bands
 * live with their own spans and are intentionally out of this slice's scope.
 *
 * Pure and side-effect free so a test pins the exact band edges — the whole
 * point of a debug threshold is that it can drift silently unless something
 * asserts it.
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
 * Decisions"): tool search yellow >25ms / red >100ms; schema build yellow
 * >50ms / red >200ms. Frozen so a consumer can read but never mutate them.
 */
export const RUNTIME_LATENCY_THRESHOLDS = Object.freeze({
  tool_search: { yellowMs: 25, redMs: 100 },
  schema_build: { yellowMs: 50, redMs: 200 },
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
