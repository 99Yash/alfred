import { INTEGRATION_DISPLAY_NAMES, type WorkflowRecoveryNavigation } from "@alfred/contracts";
import type { WorkflowReadinessProblem } from "./readiness";

const GOOGLE_INTEGRATIONS = new Set(["gmail", "calendar", "drive", "docs", "sheets", "slides"]);

/**
 * Convert a readiness remedy into navigation only when this server owns a flow
 * that can preserve the immutable draft through that remedy.
 */
export function workflowRecoveryNavigation(args: {
  workflowId: string;
  revisionId: string;
  readiness: readonly WorkflowReadinessProblem[];
}): WorkflowRecoveryNavigation | undefined {
  for (const problem of args.readiness) {
    const action = problem.recoveryAction;
    if (
      !action ||
      (action.kind !== "connect" && action.kind !== "reauthorize") ||
      !GOOGLE_INTEGRATIONS.has(action.integration)
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
