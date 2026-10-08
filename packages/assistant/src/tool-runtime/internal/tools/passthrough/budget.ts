/**
 * Per-run passthrough call ceiling (ADR-0074). A pagination loop looks like progress,
 * so the ADR-0070 non-progress backstop misses it. Over the ceiling, the boss gets a
 * visible `budget_exhausted` result, not a silent drop.
 */

import { PASSTHROUGH_TOOL_NAMES } from "@alfred/contracts";
import { db } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Cumulative across the run, so it catches a cross-turn loop. Calls in one parallel
 * batch all see the same prior count, so one batch can overshoot it.
 */
export const PASSTHROUGH_PER_RUN_CEILING = 15;

export interface PassthroughBudgetExhausted {
  outcome: "budget_exhausted";
  message: string;
  callsThisRun: number;
  ceiling: number;
}

export function passthroughBudgetExhausted(callsThisRun: number): PassthroughBudgetExhausted {
  return {
    outcome: "budget_exhausted",
    callsThisRun,
    ceiling: PASSTHROUGH_PER_RUN_CEILING,
    message:
      `You have already made ${callsThisRun} raw passthrough calls this run — the per-run ` +
      `ceiling of ${PASSTHROUGH_PER_RUN_CEILING}. Stop paginating or retrying raw reads now: ` +
      "report what you have already gathered (state that it may be incomplete), or ask the user " +
      "to narrow the request. Do not issue more passthrough calls this run.",
  };
}

/** Counts only `executed` rows, so a resumed call never counts itself twice. */
export async function countRunPassthroughCalls(runId: string): Promise<number> {
  const rows = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(actionStagings)
    .where(
      and(
        eq(actionStagings.runId, runId),
        eq(actionStagings.status, "executed"),
        inArray(actionStagings.toolName, [...PASSTHROUGH_TOOL_NAMES]),
      ),
    );

  return rows[0]?.count ?? 0;
}
