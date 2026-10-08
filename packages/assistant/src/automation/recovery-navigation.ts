import {
  INTEGRATION_DISPLAY_NAMES,
  isGoogleSlug,
  type WorkflowRecoveryNavigation,
} from "@alfred/contracts";
import type { PersistedWorkflowReadinessProblem } from "@alfred/contracts";

/** Navigation for a remedy, only when this server has a flow that keeps the draft intact. */
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
