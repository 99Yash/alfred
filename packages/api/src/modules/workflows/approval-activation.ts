import {
  activateWorkflowInputSchema,
  APPROVAL_EXPIRY_MS,
  canonicalJson,
  hashToolInput,
} from "@alfred/contracts";
import { db, type DbTransaction } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";
import { refreshWorkflowActivationProposal, type WorkflowServiceFailure } from "./revisions";

export type WorkflowApprovalEditPreparation =
  | { kind: "not_workflow" }
  | { kind: "invalid"; message: string }
  | {
      kind: "prepared";
      input: ReturnType<typeof activateWorkflowInputSchema.parse>;
      requiresReview: boolean;
    };

/** Validate and canonicalize an edited workflow card before the decision lock. */
export async function prepareWorkflowApprovalEdit(args: {
  userId: string;
  stagingId: string;
  expectedRowVersion: number;
  editedInput?: unknown;
}): Promise<WorkflowApprovalEditPreparation> {
  const [candidate] = await db()
    .select({
      toolName: actionStagings.toolName,
      proposedInput: actionStagings.proposedInput,
      rowVersion: actionStagings.rowVersion,
    })
    .from(actionStagings)
    .where(and(eq(actionStagings.id, args.stagingId), eq(actionStagings.userId, args.userId)));
  if (candidate?.toolName !== "system.activate_workflow") return { kind: "not_workflow" };
  if (candidate.rowVersion !== args.expectedRowVersion) {
    return { kind: "invalid", message: "The approval changed. Review the latest contract." };
  }

  const staged = activateWorkflowInputSchema.safeParse(candidate.proposedInput);
  const edited = activateWorkflowInputSchema.safeParse(
    args.editedInput === undefined ? candidate.proposedInput : args.editedInput,
  );
  if (!staged.success || !edited.success) {
    return { kind: "invalid", message: "The workflow activation contract is invalid." };
  }
  if (
    staged.data.workflowId !== edited.data.workflowId ||
    staged.data.baseRevisionId !== edited.data.baseRevisionId ||
    staged.data.baseContentHash !== edited.data.baseContentHash ||
    staged.data.baseRowVersion !== edited.data.baseRowVersion
  ) {
    return { kind: "invalid", message: "Workflow identity fields cannot be changed." };
  }

  const refreshed = await refreshWorkflowActivationProposal({
    userId: args.userId,
    input: edited.data,
  });
  if (!refreshed.ok) {
    return { kind: "invalid", message: workflowRefreshFailureMessage(refreshed.failure) };
  }
  return {
    kind: "prepared",
    input: refreshed.input,
    requiresReview:
      canonicalJson(reviewedDerivedContract(staged.data)) !==
      canonicalJson(reviewedDerivedContract(refreshed.input)),
  };
}

/** Keep an edited card pending when server-derived fields changed. */
export async function restageWorkflowApproval(
  tx: DbTransaction,
  stagingId: string,
  input: ReturnType<typeof activateWorkflowInputSchema.parse>,
): Promise<Date> {
  const expiresAt = new Date(Date.now() + APPROVAL_EXPIRY_MS);
  await tx
    .update(actionStagings)
    .set({
      proposedInput: input,
      proposedInputHash: hashToolInput("system.activate_workflow", input),
      decidedInput: null,
      expiresAt,
      rowVersion: sql`${actionStagings.rowVersion} + 1`,
    })
    .where(eq(actionStagings.id, stagingId));
  return expiresAt;
}

function reviewedDerivedContract(input: ReturnType<typeof activateWorkflowInputSchema.parse>) {
  const {
    workflowId: _workflowId,
    baseRevisionId: _baseRevisionId,
    baseContentHash: _baseContentHash,
    baseRowVersion: _baseRowVersion,
    definition: _definition,
    schedule,
    ...derived
  } = input;
  return {
    ...derived,
    schedule: {
      ...schedule,
      previewedAt: null,
      nextRunAt: schedule.nextRunAt ?? null,
    },
  };
}

function workflowRefreshFailureMessage(failure: WorkflowServiceFailure): string {
  if (failure.kind === "validation_failed") {
    return failure.problems.map((problem) => problem.message).join(" ");
  }
  if (failure.kind === "readiness_blocked") {
    return failure.blockers.map((blocker) => blocker.message).join(" ");
  }
  if (failure.kind === "stale_revision" || failure.kind === "row_version_conflict") {
    return "The workflow changed. Refresh it before you approve it.";
  }
  return "The workflow activation contract cannot be refreshed.";
}
