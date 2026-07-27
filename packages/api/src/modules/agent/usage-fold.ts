import type { ChatMessageUsage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { apiCallLog } from "@alfred/db/schemas";
import { eq, sql } from "drizzle-orm";

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
 * by the live finalize path ({@link aggregateRunUsage}) and the one-off backfill
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

/**
 * Roll up a run's token usage + cost from its `api_call_log` rows for the dev
 * usage readout. Keyed on the boss `runId` — sub-agent child runs are separate
 * runs billed under their own ids and are not folded in (see
 * `.lessons/model-cost-recompute-from-tokens.md`). Best-effort: metering rows
 * are written fire-and-forget, so a straggler write can undercount the final
 * call; returns null when the run logged nothing.
 *
 * Lives beside {@link foldModelUsage} rather than with the turn closure that
 * calls it: the GROUP BY and the fold are one shape, and the backfill script
 * runs the same pair widened by message id. Changing what usage records means
 * changing this file.
 */
export async function aggregateRunUsage(runId: string): Promise<ChatMessageUsage | null> {
  // Grouped by model so the readout can name every model that served the turn
  // (and catch a silent Anthropic→Gemini fallback); the turn totals are summed
  // back across the groups in JS.
  const rows = await db()
    .select({
      model: sql<string>`coalesce(${apiCallLog.model}, 'unknown')`,
      inputTokens: sql<string>`coalesce(sum(${apiCallLog.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${apiCallLog.outputTokens}), 0)`,
      cachedInputTokens: sql<string>`coalesce(sum(${apiCallLog.cachedInputTokens}), 0)`,
      costUsd: sql<string>`coalesce(sum(${apiCallLog.costUsd}), 0)`,
      calls: sql<string>`count(*)`,
    })
    .from(apiCallLog)
    .where(eq(apiCallLog.runId, runId))
    .groupBy(apiCallLog.model);
  if (rows.length === 0) return null;
  const usage = foldModelUsage(rows);
  return usage.calls === 0 ? null : usage;
}
