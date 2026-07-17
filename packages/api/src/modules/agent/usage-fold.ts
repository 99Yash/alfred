import type { ChatMessageUsage } from "@alfred/contracts";

/**
 * One `api_call_log` group summed for a single model within a run. The `sum`/
 * `count` aggregates arrive from Postgres as strings, so every numeric field
 * also accepts a `string` — {@link foldModelUsage} coerces with `Number(...)`
 * and treats `NaN`/empty as `0`.
 */
export interface ModelUsageGroup {
  model: string;
  inputTokens: string | number;
  outputTokens: string | number;
  cachedInputTokens: string | number;
  costUsd: string | number;
  calls: string | number;
}

/**
 * Fold per-model usage groups into one {@link ChatMessageUsage}: sum the turn
 * totals and carry a per-model `{ model, calls }` breakdown sorted busiest
 * first. The single home for the `(model, tokens, cost)` rollup shape — shared
 * by the live finalize path (`aggregateRunUsage`) and the one-off backfill
 * script so the two can't drift.
 */
export function foldModelUsage(groups: readonly ModelUsageGroup[]): ChatMessageUsage {
  const usage: ChatMessageUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    calls: 0,
    models: [],
  };
  for (const group of groups) {
    const calls = Number(group.calls) || 0;
    usage.inputTokens += Number(group.inputTokens) || 0;
    usage.outputTokens += Number(group.outputTokens) || 0;
    usage.cachedInputTokens += Number(group.cachedInputTokens) || 0;
    usage.costUsd += Number(group.costUsd) || 0;
    usage.calls += calls;
    usage.models.push({ model: group.model, calls });
  }
  usage.models.sort((a, b) => b.calls - a.calls);
  return usage;
}
