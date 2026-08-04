import { registerSystemToolWorkflowAdapter, type SystemToolWorkflowAdapter } from "../tool-runtime";
import { authorWorkflowDraft } from "./authoring";
import { workflowRecoveryNavigation } from "./recovery-navigation";
import type { WorkflowReadinessProblem } from "./readiness";
import { activateWorkflowDefinition, recoverWorkflowDraft } from "./revisions";

/**
 * Shape the `blocked` tool result for a draft that still has readiness problems.
 * The recovery navigation is workflow-owned policy, so it lives here beside the
 * authoring and revision calls, not in the tools module.
 */
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
 * The workflows-owned implementation of the `SystemToolWorkflowAdapter` seam.
 * The system tools (`system.author_workflow` / `system.recover_workflow` /
 * `system.activate_workflow`) call the seam; this adapter runs the workflow
 * authoring, revision, recovery, and readiness policy, then returns the exact
 * model-visible tool result. It lives in the workflows module so the tools
 * module never imports workflows (ADR-0089: the runtime composes tools, not the
 * reverse). Composition installs it at boot.
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

/**
 * Install the workflow-behavior handler behind the tool-runtime seam. The
 * composition root calls this after `registerBuiltinTools`, so a system tool
 * that reaches the seam finds a registered adapter rather than the boot-order
 * throw.
 */
export function registerWorkflowSystemToolAdapter(): () => void {
  return registerSystemToolWorkflowAdapter(workflowSystemToolAdapter);
}
