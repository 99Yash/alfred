import {
  reviseWorkflowFromPatch,
  setWorkflowStatus,
  type WorkflowDefinitionPatch,
  type WorkflowServiceFailure,
} from "@alfred/assistant/automation";
import { workflows } from "@alfred/db/schemas";
import type { WorkflowUpdateArgs } from "@alfred/sync";
import { and, eq } from "drizzle-orm";
import { MutatorForbiddenError } from "../authz";
import type { DbTransaction } from "@alfred/db";

/** None of these is retryable. The savepoint rolls back, and the next pull drops the optimistic patch. */
function workflowMutatorError(failure: WorkflowServiceFailure): MutatorForbiddenError {
  switch (failure.kind) {
    case "validation_failed":
      return new MutatorForbiddenError(failure.problems.map((p) => p.message).join(" "));
    case "builtin_immutable":
      return new MutatorForbiddenError("cannot edit a built-in workflow");
    case "no_current_revision":
      return new MutatorForbiddenError("this workflow has no saved definition to activate");
    case "row_version_conflict":
      return new MutatorForbiddenError("the workflow changed while this edit was in flight");
    case "readiness_blocked":
      return new MutatorForbiddenError(failure.blockers.map((p) => p.message).join(" "));
    case "stale_revision":
      return new MutatorForbiddenError("the workflow definition changed before activation");
    case "slug_taken":
      return new MutatorForbiddenError(`a workflow named '${failure.slug}' already exists`);
    case "not_found":
      return new MutatorForbiddenError("workflow not found");
    default: {
      const unhandled: never = failure;

      return unhandled;
    }
  }
}

/**
 * Patch a user workflow through the revision service. An edit to a published
 * workflow makes unpublished changes. Activation is refused here: it needs the
 * `system.activate_workflow` approval.
 */
export async function workflowUpdate(
  tx: DbTransaction,
  args: WorkflowUpdateArgs,
  userId: string,
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(workflows)
    .where(and(eq(workflows.userId, userId), eq(workflows.slug, args.slug)))
    .limit(1);

  // Replicache retries, so a deleted row must not wedge the client.
  if (!existing) return;

  if (existing.isBuiltin) {
    throw new MutatorForbiddenError("cannot edit a built-in workflow");
  }

  if (args.status === "active") {
    throw new MutatorForbiddenError(
      "workflow activation requires the exact high-risk approval contract",
    );
  }

  const patch: WorkflowDefinitionPatch = {
    name: args.name,
    description: args.description,
    brief: args.brief,
    trigger: args.trigger,
    allowedIntegrations: args.allowedIntegrations,
  };

  const hasDefinitionPatch = Object.values(patch).some((value) => value !== undefined);

  if (hasDefinitionPatch) {
    const revised = await reviseWorkflowFromPatch({
      userId,
      workflowId: existing.id,
      patch,
      expectedRowVersion: args.expectedRowVersion,
      tx,
    });

    if (!revised.ok) throw workflowMutatorError(revised.failure);
  }

  if (args.status === undefined) return;

  const applied = await setWorkflowStatus({
    userId,
    workflowId: existing.id,
    status: args.status,
    ...(hasDefinitionPatch ? {} : { expectedRowVersion: args.expectedRowVersion }),
    tx,
  });

  if (!applied.ok) {
    throw workflowMutatorError(applied.failure);
  }
}
