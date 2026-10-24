/**
 * The approval rule (ADR-0034, ADR-0069). Dispatch applies it to each call. The connected
 * summary applies it to each listed tool, so the prompt and the gate cannot disagree.
 */

import type { PolicyMode, ToolName, ToolRiskTier } from "@alfred/contracts";
import { getTool } from "./internal/registry";

/**
 * Approval is needed when policy is `gated` or the tier is `high`.
 * "Auto" must not authorize an irreversible action, such as a real email send.
 * Dispatch and `toolCallWouldGate` both use this one gate.
 */
export function toolRequiresApproval(policyMode: PolicyMode, riskTier: ToolRiskTier): boolean {
  return policyMode === "gated" || riskTier === "high";
}

/**
 * Whether every call of `toolName` parks for approval under `policyMode`, whatever its input.
 * The model skips its own confirm question for a tool this marks, so it must never mark a tool
 * that a call can run without a card. It under-reports instead: a dynamic tier that can rise
 * to `high` counts as not waiting. The opposite bias of `toolCallWouldGate`.
 */
export function toolAlwaysWaitsForApproval(toolName: ToolName, policyMode: PolicyMode): boolean {
  const tool = getTool(toolName);

  if (!tool) return false;

  switch (tool.staging) {
    case "fast_path":
    case "join":
      return false;
    case "question":
      // ADR-0099: `STAGING_ARM.question.forcesApproval`.
      return true;
    case "staged": {
      // A declared downgrade can take the tier below `high`. Dispatch clamps an undeclared one.
      const lowestTier = tool.riskTierDowngradeReason === undefined ? tool.riskTier : "no_risk";

      return toolRequiresApproval(policyMode, lowestTier);
    }
  }
}
