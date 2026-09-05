import {
  INTEGRATION_DISPLAY_NAMES,
  isGoogleSlug,
  type WorkflowRecoveryNavigation,
} from "@alfred/contracts";
import type { PersistedWorkflowReadinessProblem } from "@alfred/contracts";

/**
 * Convert a readiness remedy into navigation only when this server owns a flow
 * that can preserve the immutable draft through that remedy.
 */
export function workflowRecoveryNavigation(args: {
  workflowId: string;
  revisionId: string;
  readiness: readonly PersistedWorkflowReadinessProblem[];
}): WorkflowRecoveryNavigation | undefined {
  for (const problem of args.readiness) {
    const action = problem.recoveryAction;
    if (
      !action ||
      (action.kind !== "connect" && action.kind !== "reauthorize") ||
      !isGoogleSlug(action.integration)
    ) {
      continue;
    }
    const query = new URLSearchParams({
      workflowId: args.workflowId,
      revisionId: args.revisionId,
    });
    const verb = action.kind === "reauthorize" ? "Reconnect" : "Connect";
    return {
      kind: "oauth",
      label: `${verb} ${INTEGRATION_DISPLAY_NAMES[action.integration]}`,
      path: `/api/integrations/google/connect?${query.toString()}`,
    };
  }
  return undefined;
}
