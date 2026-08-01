import type { WorkflowRevisionDefinition } from "@alfred/contracts";
import { toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, workflowRevisions, workflows } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { createToolCatalog, listRegisteredTools } from "../tools/registry";
import { readWorkflowReadinessContext } from "./readiness-context";
import { resolveWorkflowReadiness, type WorkflowReadinessProblem } from "./readiness";
import { reconcileWorkflowReadiness } from "./revisions";

export type RuntimeReadinessResult =
  | { kind: "ready" }
  | { kind: "deferred"; reason: string }
  | { kind: "blocked"; problems: WorkflowReadinessProblem[]; newlyBlocked: boolean };

export function runtimeReadinessDisposition(
  problems: readonly WorkflowReadinessProblem[],
): "ready" | "deferred" | "blocked" {
  if (problems.length === 0) return "ready";
  return problems.every((problem) => problem.code === "provider_unhealthy")
    ? "deferred"
    : "blocked";
}

/** Recheck one run's exact pinned revision against mutable provider state. */
export async function checkWorkflowRunReadiness(args: {
  runId: string;
  userId: string;
}): Promise<RuntimeReadinessResult> {
  const [row] = await db()
    .select({ run: agentRuns, workflow: workflows, revision: workflowRevisions })
    .from(agentRuns)
    .leftJoin(
      workflowRevisions,
      and(
        eq(workflowRevisions.id, agentRuns.workflowRevisionId),
        eq(workflowRevisions.userId, agentRuns.userId),
      ),
    )
    .leftJoin(
      workflows,
      and(eq(workflows.userId, agentRuns.userId), eq(workflows.slug, agentRuns.workflowSlug)),
    )
    .where(and(eq(agentRuns.id, args.runId), eq(agentRuns.userId, args.userId)))
    .limit(1);

  if (!row) throw new Error(`[workflows:readiness] run not found: ${args.runId}`);
  // Built-ins and sub-agents do not pin a user-authored revision.
  if (!row.run.workflowRevisionId) return { kind: "ready" };
  if (!row.workflow || !row.revision) {
    throw new Error(`[workflows:readiness] pinned revision is unavailable: ${args.runId}`);
  }

  let context: Awaited<ReturnType<typeof readWorkflowReadinessContext>>;
  try {
    context = await readWorkflowReadinessContext(args.userId);
  } catch (error) {
    return { kind: "deferred", reason: toMessage(error) };
  }

  const definition: WorkflowRevisionDefinition = {
    name: row.revision.name,
    description: row.revision.description,
    brief: row.revision.brief,
    trigger: row.revision.trigger,
    allowedIntegrations: row.revision.allowedIntegrations,
    allowedTools: row.revision.allowedTools,
    requiredCapabilities: row.revision.requiredCapabilities,
  };
  const problems = resolveWorkflowReadiness({
    definition,
    availability: context.availability,
    gmailEventHealth: context.gmailEventHealth,
    toolCatalog: createToolCatalog(listRegisteredTools()),
  });

  const disposition = runtimeReadinessDisposition(problems);
  if (disposition === "deferred") {
    return { kind: "deferred", reason: problems.map((problem) => problem.message).join(" ") };
  }

  const recorded = await db().transaction(async (tx) => {
    const [lockedWorkflow] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, row.workflow!.id), eq(workflows.userId, args.userId)))
      .for("update");
    if (!lockedWorkflow) throw new Error(`[workflows:readiness] workflow disappeared`);
    const before = lockedWorkflow.blocked;
    const reconciled = await reconcileWorkflowReadiness({
      userId: args.userId,
      workflow: lockedWorkflow,
      revisionId: row.revision!.id,
      readiness: problems,
      target: "activation",
      tx,
    });
    return { before, reconciled };
  });
  if (!recorded.reconciled.ok) {
    throw new Error(`[workflows:readiness] failed to record readiness verdict`);
  }
  if (disposition === "ready") return { kind: "ready" };
  return {
    kind: "blocked",
    problems,
    newlyBlocked:
      recorded.before?.code !== recorded.reconciled.workflow.blocked?.code ||
      recorded.before?.message !== recorded.reconciled.workflow.blocked?.message ||
      recorded.before?.revisionId !== recorded.reconciled.workflow.blocked?.revisionId,
  };
}
