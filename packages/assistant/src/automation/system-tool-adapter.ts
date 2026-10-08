import {
  registerSystemToolWorkflowAdapter,
  type SystemToolWorkflowAdapter,
} from "@alfred/assistant/tool-runtime";
import { authorWorkflowDraft } from "./authoring";
import { workflowRecoveryNavigation } from "./recovery-navigation";
import type { WorkflowReadinessProblem } from "./readiness";
import { activateWorkflowDefinition, recoverWorkflowDraft } from "./revisions";

/** The `blocked` result for a draft with readiness problems. Recovery navigation is workflow policy. */
function blockedWorkflowRecoveryResult(args: {
  workflowId: string;
  revisionId: string;
  readiness: readonly WorkflowReadinessProblem[];
}) {
  const recovery = workflowRecoveryNavigation(args);

  return {
    ok: true as const,
    status: "blocked" as const,
    workflowId: args.workflowId,
    revisionId: args.revisionId,
    readinessBlockers: args.readiness,
    ...(recovery ? { recovery } : {}),
  };
}

/**
 * Workflow side of the `SystemToolWorkflowAdapter` seam, for the `system.*_workflow` tools.
 * Lives here so the tools module never imports workflows (ADR-0089). Installed at boot.
 */
const workflowSystemToolAdapter: SystemToolWorkflowAdapter = {
  async authorWorkflow(args) {
    const result = await authorWorkflowDraft({
      userId: args.userId,
      runId: args.runId,
      timezone: args.timezone,
      input: args.input,
    });

    if (!result.ok) return { ok: false, status: result.failure.kind, failure: result.failure };

    if (result.readiness.length > 0 || !result.activationProposal) {
      return {
        ...blockedWorkflowRecoveryResult({
          workflowId: result.workflow.id,
          revisionId: result.revision.id,
          readiness: result.readiness,
        }),
        rowVersion: result.workflow.rowVersion,
        revisionNumber: result.revision.revisionNumber,
        created: result.created,
      };
    }

    return {
      ok: true,
      status: "ready_to_activate",
      workflowId: result.workflow.id,
      revisionId: result.revision.id,
      revisionNumber: result.revision.revisionNumber,
      contentHash: result.revision.contentHash,
      created: result.created,
      activationProposal: result.activationProposal,
    };
  },

  async recoverWorkflow(args) {
    const result = await recoverWorkflowDraft({
      userId: args.userId,
      workflowId: args.workflowId,
      revisionId: args.revisionId,
    });

    if (!result.ok) return { ok: false, status: result.failure.kind, failure: result.failure };

    if (!result.activationProposal) {
      return blockedWorkflowRecoveryResult({
        workflowId: result.workflow.id,
        revisionId: result.revision.id,
        readiness: result.readiness,
      });
    }

    return {
      ok: true,
      status: "ready_to_activate",
      workflowId: result.workflow.id,
      revisionId: result.revision.id,
      activationProposal: result.activationProposal,
    };
  },

  async activateWorkflow(args) {
    const result = await activateWorkflowDefinition({
      userId: args.userId,
      input: args.input,
      createdByRunId: args.createdByRunId,
    });

    if (!result.ok) return { ok: false, status: result.failure.kind, failure: result.failure };

    return {
      ok: true,
      status: "activated",
      workflowId: result.workflow.id,
      revisionId: result.revision.id,
      revisionNumber: result.revision.revisionNumber,
      contentHash: result.revision.contentHash,
      nextRunAt: result.workflow.nextRunAt?.toISOString() ?? null,
      revisedFromApprovalEdit: result.revised,
    };
  },
};

/** Install after `registerBuiltinTools`, so a system tool never hits the boot-order throw. */
export function registerWorkflowSystemToolAdapter(): () => void {
  return registerSystemToolWorkflowAdapter(workflowSystemToolAdapter);
}
