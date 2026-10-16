import {
  activateWorkflowInputSchema,
  canonicalJson,
  hashToolInput,
  jsonValueSchema,
  type JsonValue,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { actionStagings } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import type { StagedApproval } from "@alfred/assistant/execution";
import { refreshWorkflowActivationProposal, type WorkflowServiceFailure } from "./revisions";

export type StagedApprovalPreparation =
  | { kind: "invalid"; message: string }
  | { kind: "prepared"; approval: StagedApproval };

/**
 * Turn an approve click into what `stagedAction(...).decide` writes. It reads outside the decision
 * transaction, so the row lock stays short. A workflow activation card is validated and
 * canonicalized here. Every other card approves the user's edit as sent.
 */
export async function prepareStagedApproval(args: {
  userId: string;
  stagingId: string;
  expectedRowVersion: number;
  editedInput: JsonValue | undefined;
}): Promise<StagedApprovalPreparation> {
  const [candidate] = await db()
    .select({
      toolName: actionStagings.toolName,
      proposedInput: actionStagings.proposedInput,
      rowVersion: actionStagings.rowVersion,
    })
    .from(actionStagings)
    .where(and(eq(actionStagings.id, args.stagingId), eq(actionStagings.userId, args.userId)));

  if (candidate?.toolName !== "system.activate_workflow") {
    return { kind: "prepared", approval: { kind: "decide", decidedInput: args.editedInput } };
  }

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

  // #374: one parse feeds every column, so readers can trust the display column.
  const input = jsonValueSchema.parse(refreshed.input);

  const requiresReview =
    canonicalJson(reviewedDerivedContract(staged.data)) !==
    canonicalJson(reviewedDerivedContract(refreshed.input));

  if (!requiresReview) {
    return { kind: "prepared", approval: { kind: "decide", decidedInput: input } };
  }

  // Server-derived fields changed, so the user must approve the card again after seeing them.
  return {
    kind: "prepared",
    approval: {
      kind: "restage",
      revision: {
        proposedInput: input,
        // There is no redactor for workflow activation yet; add one here if needed.
        displayInput: input,
        proposedInputHash: hashToolInput("system.activate_workflow", refreshed.input),
      },
    },
  };
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
