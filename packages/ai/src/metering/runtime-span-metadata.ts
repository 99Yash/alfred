// Metadata helpers shared by both runtime span families, so their thresholds and caps cannot drift.

export type LatencyHealth = "ok" | "yellow" | "red";

interface LatencyThreshold {
  /** Above this many ms is yellow. */
  yellowMs: number;
  /** Above this many ms is red. */
  redMs: number;
}

/** Debug thresholds for the lazy-tool spans. */
export const RUNTIME_LATENCY_THRESHOLDS = Object.freeze({
  tool_search: { yellowMs: 25, redMs: 100 },
  schema_rebuild: { yellowMs: 50, redMs: 200 },
} satisfies Record<string, LatencyThreshold>);

export type RuntimeLatencyKind = keyof typeof RUNTIME_LATENCY_THRESHOLDS;

/** A latency exactly on an edge stays in the lower band. */
export function classifyLatency(kind: RuntimeLatencyKind, ms: number): LatencyHealth {
  const threshold = RUNTIME_LATENCY_THRESHOLDS[kind];

  if (ms > threshold.redMs) return "red";

  if (ms > threshold.yellowMs) return "yellow";

  return "ok";
}

/** Join tool names with a length cap, so span metadata stays bounded. Null for an empty list. */
export function boundedNameList(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const joined = names.join(",");

  return joined.length <= 800 ? joined : `${joined.slice(0, 797)}...`;
}
