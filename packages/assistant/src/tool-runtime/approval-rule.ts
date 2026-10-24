/**
 * The approval rule (ADR-0034, ADR-0069) and its two predictors. Dispatch applies the rule to
 * each call. The batch scheduler and the connected summary predict it before a call, so the
 * prompt, the scheduler, and the gate cannot disagree.
 */

import { isToolName, type PolicyMode, type ToolName, type ToolRiskTier } from "@alfred/contracts";
import { resolvePolicyMode } from "@alfred/assistant/action-policies";
import { STAGING_ARM } from "./internal/dispatch/staging-arm";
import { getTool } from "./internal/registry";

/**
 * Approval is needed when policy is `gated` or the tier is `high`.
 * "Auto" must not authorize an irreversible action, such as a real email send.
 * Dispatch and both predictors use this one gate.
 */
export function toolRequiresApproval(policyMode: PolicyMode, riskTier: ToolRiskTier): boolean {
  return policyMode === "gated" || riskTier === "high";
}

/**
 * Predict whether a fresh dispatch would park for approval. A scheduling hint,
 * not a gate: batch callers run gated calls one at a time, because a run parks
 * on one `approvalId` and a sibling card fails with 409 `wake_mismatch`.
 * Over-reports `resolveRiskTier` tools and `fast_path` tools. Ignores chat full autonomy on
 * purpose: the flag can turn off mid-batch, and then parallel gated siblings would collide.
 */
export async function toolCallWouldGate(userId: string, toolName: string): Promise<boolean> {
  if (!isToolName(toolName)) return false;
  const policyMode = await resolvePolicyMode(userId, toolName);
  const tool = getTool(toolName);

  if (!tool) return false;

  // The `question` arm always parks (ADR-0099).
  if (STAGING_ARM[tool.staging]?.forcesApproval) return true;

  // No validated input here, so assume a dynamic tier may gate.
  if (tool.resolveRiskTier) return true;

  return toolRequiresApproval(policyMode, tool.riskTier);
}

/**
 * Whether every call of `toolName` parks for approval under `policyMode`, whatever its input.
 * The model skips its own confirm question for a tool this marks, so it must never mark a tool
 * that a call can run without a card. It under-reports instead: a dynamic tier that can rise
 * to `high` counts as not waiting. The opposite bias of `toolCallWouldGate`.
 * Ignores chat full autonomy: under it the model skips its own confirm question, which is the
 * user's intent, and a switch back to Review mid-turn only adds a second confirm.
 */
export function toolAlwaysWaitsForApproval(toolName: ToolName, policyMode: PolicyMode): boolean {
  const tool = getTool(toolName);

  if (!tool) return false;

  const arm = STAGING_ARM[tool.staging];

  // `join` and `fast_path` return before the gate.
  if (!arm) return false;

  if (arm.forcesApproval) return true;

  // A declared downgrade can take the tier below `high`. Dispatch clamps an undeclared one.
  const lowestTier = tool.riskTierDowngradeReason === undefined ? tool.riskTier : "no_risk";

  return toolRequiresApproval(policyMode, lowestTier);
}
