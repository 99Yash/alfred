import {
  registerWorkflowRecoveryHandler,
  type WorkflowRecoveryResult,
} from "@alfred/assistant/connections/ingestion";
import { recoverWorkflowDraft } from "@alfred/assistant/automation";

let unregisterWorkflowRecoveryHandler: (() => void) | undefined;

function connectionRecoveryResult(
  recovered: Awaited<ReturnType<typeof recoverWorkflowDraft>>,
): WorkflowRecoveryResult {
  if (!recovered.ok) {
    return { status: "failure", failureKind: recovered.failure.kind };
  }

  return {
    status: recovered.activationProposal ? "ready" : "blocked",
    workflowSlug: recovered.workflow.slug,
    revisionId: recovered.revision.id,
  };
}

/** Connect workflow draft recovery without making integrations import workflows. */
export function registerWorkflowRecovery(): void {
  if (unregisterWorkflowRecoveryHandler) return;
  unregisterWorkflowRecoveryHandler = registerWorkflowRecoveryHandler(async (request) =>
    connectionRecoveryResult(await recoverWorkflowDraft(request)),
  );
}

export function unregisterWorkflowRecovery(): void {
  unregisterWorkflowRecoveryHandler?.();
  unregisterWorkflowRecoveryHandler = undefined;
}
