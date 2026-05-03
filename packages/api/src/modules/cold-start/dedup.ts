import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, eq, ne, notInArray } from "drizzle-orm";
import { COLD_START_WORKFLOW_SLUG } from "./workflow-input";

/**
 * Statuses that count as "blocking a re-trigger." A `failed` or
 * `cancelled` run does NOT block — a transient Perplexity outage or
 * worker crash should be recoverable from a later reconnect, not a
 * permanent lockout that needs manual DB cleanup.
 *
 * Anything else (`pending`, `runnable`, `running`, `waiting`,
 * `completed`) is either in-flight or already produced results, so
 * re-firing would either race or duplicate spend.
 */
const TERMINAL_FAILURE_STATUSES: string[] = ["failed", "cancelled"];

export interface HasPriorColdStartRunOpts {
  /**
   * Skip a specific run id when checking. The workflow's own
   * `gather-signals` step uses this to ignore the run row that was just
   * inserted to fire the workflow itself — otherwise the check would
   * always be true once the run is enqueued.
   */
  excludeRunId?: string;
}

/**
 * `true` if this user has a prior non-failed cold-start research run on
 * file. Used in two places:
 *
 *   1. OAuth-callback trigger — gates lifetime uniqueness so a re-connect
 *      doesn't burn another Sonar Deep Research call.
 *   2. Workflow's first step (when `force` is false) — gates the
 *      generic `/api/agent/runs` re-invocation path. Authenticated users
 *      can hit that endpoint with any registered slug; without a check
 *      here, they could spam expensive runs.
 *
 * The smoke script and any future settings-page "re-research" button
 * pass `force: true` on the workflow input, which bypasses (2).
 *
 * Failed/cancelled runs are excluded so they don't permanently suppress
 * the trigger after a transient outage.
 */
export async function hasPriorColdStartRun(
  userId: string,
  opts: HasPriorColdStartRunOpts = {},
): Promise<boolean> {
  const filters = [
    eq(agentRuns.userId, userId),
    eq(agentRuns.workflowSlug, COLD_START_WORKFLOW_SLUG),
    notInArray(agentRuns.status, TERMINAL_FAILURE_STATUSES),
  ];
  if (opts.excludeRunId) filters.push(ne(agentRuns.id, opts.excludeRunId));

  const rows = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(...filters))
    .limit(1);
  return rows.length > 0;
}
