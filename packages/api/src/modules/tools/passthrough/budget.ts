/**
 * Per-run passthrough call ceiling (ADR-0074 rung-a, epic #271).
 *
 * The general read-only tier can paginate. A runaway pagination/retry loop reads
 * as *forward progress* (each page is a different, materially-changed request),
 * so it slips past the ADR-0070 non-progress backstop — that backstop trips on
 * repeated identical/no-progress steps, which a paginating loop is not. This
 * module is the dedicated guard: a cumulative cap on raw passthrough calls per
 * agent run, enforced by the dispatcher just before it executes a passthrough
 * tool.
 *
 * Exceeding the ceiling does NOT silently drop the call — it returns a VISIBLE,
 * honest envelope (`outcome: "budget_exhausted"`) so the boss reads it as a
 * normal tool result and stops paginating rather than being cut off with no
 * explanation.
 */

import { PASSTHROUGH_TOOL_NAMES } from "@alfred/contracts";
import { db } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Max raw passthrough calls that may execute within one agent run before the
 * ceiling fires. Sized well above a legitimate multi-page read (a handful of
 * pages) but below a runaway loop. Cumulative across the run's turns/steps,
 * which is what actually catches a cross-turn pagination loop — a per-batch cap
 * would reset every turn and never bound the loop.
 *
 * This is a per-RUN bound, not a per-turn one, and the distinction is load-
 * bearing: a single dispatch batch fans out its autonomy calls in parallel, so
 * N passthrough calls issued in *one* turn all observe the same prior-executed
 * count and can slip past together. The cap holds across subsequent turns (each
 * executed call raises the count), which is exactly the threat it targets — a
 * sequential pagination loop that needs each prior result before issuing the
 * next. A single parallel batch is bounded only by the model's max-tool-calls-
 * per-batch and provider rate limits, not by this ceiling.
 */
export const PASSTHROUGH_PER_RUN_CEILING = 15;

/**
 * The honest "budget exhausted" envelope handed back to the boss as a normal
 * (executed) tool result. Mirrors the shape discipline of {@link
 * PassthroughResult}: an `outcome` the model can branch on plus a plain-text
 * `message` telling it what to do instead (stop, report what it has, narrow).
 */
export interface PassthroughBudgetExhausted {
  outcome: "budget_exhausted";
  message: string;
  callsThisRun: number;
  ceiling: number;
}

/** Build the visible budget-exhausted envelope for a run that hit the ceiling. */
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

/**
 * Count the passthrough calls already *executed* in this run. Only `executed`
 * rows count, so an in-flight or gated call is not double-counted and — because
 * an already-executed call short-circuits on the `executed` staging status
 * before this check runs — a crash/resume re-dispatch never re-counts itself.
 */
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
