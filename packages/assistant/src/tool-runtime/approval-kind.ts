import type { ApprovalKind } from "@alfred/contracts";
import { isToolName } from "@alfred/contracts";
import { getTool } from "./internal/registry";

/**
 * The `hil` approval kind a staged call of this tool parks on (ADR-0099). The
 * kind is DERIVED from the registered tool's staging arm, never stored on
 * `action_stagings`: a `question` tool parks on `question`, everything else on
 * `action_staging`. The dispatcher writes the wake with this function and the
 * decision route + expiry worker match it with the same function, so
 * `signalRunInTx` cannot answer `wake_mismatch` because two callers spelled the
 * kind by hand. An unregistered or unknown name is an ordinary staged action.
 */
export function approvalKindForTool(toolName: string): ApprovalKind {
  if (!isToolName(toolName)) return "action_staging";
  return getTool(toolName)?.staging === "question" ? "question" : "action_staging";
}
