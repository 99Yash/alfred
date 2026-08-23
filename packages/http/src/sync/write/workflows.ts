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
import type { ServerMutatorCtx } from "./mutator";

/**
 * Turn a revision-service failure into the one error `push.ts` understands.
 *
 * The savepoint around each mutator rolls back on any throw, so a rejected edit
 * leaves no partial revision behind. `MutatorForbiddenError` is the right
 * carrier for all of these: none is retryable, and the client's optimistic
 * patch is discarded on the next authoritative pull either way.
 */
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
 * Patch a user-authored workflow (m13 Phase 8 event-trigger authoring).
 *
 * Every definition write goes through the revision service (#555) — this
 * mutator owns transport concerns only: find the row by slug, split the patch
 * into "what it does" and "whether it runs", and turn a typed service failure
 * into the ACL error `push.ts` already handles.
 *
 * An edit appends a revision and moves `current_revision_id`. On an
 * already-published workflow the running definition is untouched, so the
 * editor produces *unpublished changes* rather than a live rewrite.
 * Activation is refused here: publication must pass through the staged,
 * high-risk exact-contract approval owned by `system.activate_workflow`.
 */
export async function workflowUpdate(
  tx: DbTransaction,
  args: WorkflowUpdateArgs,
  ctx: ServerMutatorCtx,
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(workflows)
    .where(and(eq(workflows.userId, ctx.userId), eq(workflows.slug, args.slug)))
    .limit(1);
  // Unknown slug → drop silently (Replicache at-least-once; a deleted row
  // shouldn't wedge the client). Built-in rows are read-only.
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
      userId: ctx.userId,
      workflowId: existing.id,
      patch,
      expectedRowVersion: args.expectedRowVersion,
      tx,
    });
    if (!revised.ok) throw workflowMutatorError(revised.failure);
  }

  if (args.status === undefined) return;
  const applied = await setWorkflowStatus({
    userId: ctx.userId,
    workflowId: existing.id,
    status: args.status,
    ...(hasDefinitionPatch ? {} : { expectedRowVersion: args.expectedRowVersion }),
    tx,
  });
  if (!applied.ok) {
    throw workflowMutatorError(applied.failure);
  }
}
