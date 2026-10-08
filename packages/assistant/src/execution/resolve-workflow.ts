import { db } from "@alfred/db";
import {
  workflowRevisions,
  workflows,
  type Workflow as WorkflowRow,
  type WorkflowRevision,
} from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { getWorkflow, type AgentDbExecutor, type Workflow } from "./registry";
import { userAuthoredBriefWorkflow } from "./workflows/user-authored-brief";

type UserAuthoredWorkflowRow = Pick<WorkflowRow, "isBuiltin"> &
  Pick<
    WorkflowRevision,
    "brief" | "allowedIntegrations" | "allowedTools" | "requiredCapabilities" | "approvedAt"
  > & { workflowId: string; revisionId: string };

export interface ResolvedWorkflowForRun {
  workflow: Workflow<unknown>;
  workflowSlug: string;
  userAuthoredRow?: UserAuthoredWorkflowRow;
}

/**
 * A slug only in the `workflows` table is user-authored and runs the shared brief workflow.
 * A builtin slug missing from the registry is a deploy mismatch, so it throws.
 */
export async function resolveWorkflowForRun(args: {
  userId: string;
  workflowSlug: string;
  workflowRevisionId?: string | undefined;
  /** A delayed occurrence must not move to a newer published revision. */
  requireSelectedRevision?: boolean | undefined;
  tx?: AgentDbExecutor;
}): Promise<ResolvedWorkflowForRun> {
  const registered = getWorkflow(args.workflowSlug);

  if (registered) {
    if (args.workflowRevisionId) {
      throw new Error(
        `[agent] builtin workflow slug=${args.workflowSlug} cannot pin a database revision`,
      );
    }

    return { workflow: registered, workflowSlug: registered.slug };
  }

  const ex = args.tx ?? db();

  const rows = await ex
    .select({
      workflowId: workflows.id,
      brief: workflowRevisions.brief,
      allowedIntegrations: workflowRevisions.allowedIntegrations,
      isBuiltin: workflows.isBuiltin,
      publishedRevisionId: workflows.publishedRevisionId,
      allowedTools: workflowRevisions.allowedTools,
      requiredCapabilities: workflowRevisions.requiredCapabilities,
      approvedAt: workflowRevisions.approvedAt,
    })
    .from(workflows)
    .leftJoin(
      workflowRevisions,
      and(
        eq(workflowRevisions.workflowId, workflows.id),
        eq(
          workflowRevisions.id,
          args.workflowRevisionId ??
            (args.requireSelectedRevision ? sql`NULL` : workflows.publishedRevisionId),
        ),
      ),
    )
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

  const revisionId =
    args.workflowRevisionId ?? (args.requireSelectedRevision ? null : row.publishedRevisionId);

  if (
    !revisionId ||
    row.brief === null ||
    row.allowedIntegrations === null ||
    !row.allowedTools ||
    !row.requiredCapabilities ||
    !row.approvedAt
  ) {
    throw new Error(
      `[agent] authored workflow slug=${args.workflowSlug} has no approved selected revision`,
    );
  }

  return {
    // SAFETY: workflows are stored type-erased to Workflow<unknown>.
    workflow: userAuthoredBriefWorkflow as Workflow<unknown>,
    workflowSlug: args.workflowSlug,
    userAuthoredRow: {
      brief: row.brief,
      allowedIntegrations: row.allowedIntegrations,
      isBuiltin: row.isBuiltin,
      workflowId: row.workflowId,
      revisionId,
      allowedTools: row.allowedTools,
      requiredCapabilities: row.requiredCapabilities,
      approvedAt: row.approvedAt,
    },
  };
}
