import { db } from "@alfred/db";
import { agentRuns } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { COLD_START_WORKFLOW_SLUG } from "./workflow-input";

/**
 * `true` if this user has *any* prior cold-start research run on file
 * (regardless of status). Used by the OAuth-callback trigger to enqueue
 * exactly once across the user's lifetime — we don't want a re-connect
 * to spend $1–5 on Sonar Deep Research a second time.
 *
 * The smoke script bypasses this check via the workflow's `force` input
 * and writes a fresh run independently.
 */
export async function hasPriorColdStartRun(userId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.workflowSlug, COLD_START_WORKFLOW_SLUG),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
