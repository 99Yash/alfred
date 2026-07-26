import { db } from "@alfred/db";
import { workflows, type Workflow as WorkflowRow } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { getWorkflow } from "./registry";
import type { AgentDbExecutor, Workflow } from "./types";
import { userAuthoredBriefWorkflow } from "./workflows/user-authored-brief";

type UserAuthoredWorkflowRow = Pick<WorkflowRow, "brief" | "allowedIntegrations" | "isBuiltin">;

export interface ResolvedWorkflowForRun {
  workflow: Workflow<unknown>;
  workflowSlug: string;
  userAuthoredRow?: UserAuthoredWorkflowRow;
}

/**
 * Map a run's `workflow_slug` to the workflow body that executes it.
 *
 * Lives in its own module rather than in `service.ts` because three unrelated
 * layers need it — `createRun`, the executor's step resolution, and
 * terminal-run closure — and routing the last of those through `service.ts`
 * would make `service` ↔ `terminal-closure` a cycle.
 *
 * A registered slug resolves to its own definition. A slug that is only in the
 * `workflows` table is user-authored: it keeps its DB slug on `agent_runs` but
 * executes the shared user-authored-brief body. A builtin slug missing from the
 * registry is a deploy mismatch, not a user-authored run, so it throws.
 */
export async function resolveWorkflowForRun(args: {
  userId: string;
  workflowSlug: string;
  tx?: AgentDbExecutor;
}): Promise<ResolvedWorkflowForRun> {
  const registered = getWorkflow(args.workflowSlug);
  if (registered) return { workflow: registered, workflowSlug: registered.slug };

  const ex = args.tx ?? db();
  const rows = await ex
    .select({
      brief: workflows.brief,
      allowedIntegrations: workflows.allowedIntegrations,
      isBuiltin: workflows.isBuiltin,
    })
    .from(workflows)
    .where(and(eq(workflows.userId, args.userId), eq(workflows.slug, args.workflowSlug)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`[agent] no workflow registered or authored for slug=${args.workflowSlug}`);
  }
  if (row.isBuiltin) {
    throw new Error(
      `[agent] builtin workflow slug=${args.workflowSlug} exists in DB but is not registered in code`,
    );
  }

  return {
    workflow: userAuthoredBriefWorkflow as Workflow<unknown>,
    workflowSlug: args.workflowSlug,
    userAuthoredRow: row,
  };
}
