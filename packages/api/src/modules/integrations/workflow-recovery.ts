import { toMessage } from "@alfred/contracts";

export interface WorkflowRecoveryRequest {
  userId: string;
  workflowId: string;
  revisionId: string;
}

export type WorkflowRecoveryResult =
  | {
      status: "ready" | "blocked";
      workflowSlug: string;
      revisionId: string;
    }
  | {
      status: "failure";
      failureKind: string;
    };

export type WorkflowRecoveryHandler = (
  request: WorkflowRecoveryRequest,
) => Promise<WorkflowRecoveryResult>;

let recoveryHandler: WorkflowRecoveryHandler | undefined;

/** Register the workflow adapter that runtime composition supplies. */
export function registerWorkflowRecoveryHandler(handler: WorkflowRecoveryHandler): () => void {
  if (recoveryHandler) {
    throw new Error("[integrations] a workflow recovery handler is already registered");
  }
  recoveryHandler = handler;

  return () => {
    if (recoveryHandler === handler) recoveryHandler = undefined;
  };
}

/**
 * Revalidate one workflow draft after a connection flow and select its SPA
 * redirect. Workflow result details stay behind the registered adapter; this
 * module owns only the connection-facing ready, blocked, and failure states.
 */
export async function resolveWorkflowRecoveryTarget(
  request: WorkflowRecoveryRequest,
): Promise<string> {
  try {
    if (!recoveryHandler) {
      throw new Error("[integrations] no workflow recovery handler is registered");
    }

    const recovered = await recoveryHandler(request);
    if (recovered.status === "failure") {
      return `/workflows?workflow_recovery=${encodeURIComponent(recovered.failureKind)}`;
    }

    return `/workflows/${encodeURIComponent(recovered.workflowSlug)}?workflow_recovery=${recovered.status}&revision_id=${encodeURIComponent(recovered.revisionId)}`;
  } catch (err) {
    console.warn(
      `[google.callback] failed to recover workflow ${request.workflowId}:`,
      toMessage(err),
    );
    return "/workflows?workflow_recovery=failed";
  }
}
