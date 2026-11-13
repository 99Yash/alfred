/**
 * The approval rule (ADR-0034, ADR-0069) and its two predictors. Dispatch applies the rule to
 * each call. The batch scheduler and the connected summary predict it before a call, so the
 * prompt, the scheduler, and the gate cannot disagree. Chat full autonomy is not part of the
 * forecast: the round reads it once, and dispatch reads it live for each call.
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
 * How a fresh dispatch of `toolName` would meet the approval gate. A scheduling hint, not a gate.
 * - `none`: no card.
 * - `waivable`: a card that chat full autonomy waives (policy, tier, or a dynamic tier).
 * - `always`: a card that nothing waives (the `confirm` and `question` arms).
 */
export type ApprovalForecast = "none" | "waivable" | "always";

/**
 * Forecast the approval gate for a fresh dispatch. Batch callers run every call that can stage a
 * card one at a time, because a run parks on one `approvalId` and a sibling card fails with 409
 * `wake_mismatch`. Over-reports `resolveRiskTier` tools and `fast_path` tools. Does not read chat
 * full autonomy: the round reads it, and dispatch reads it again live for each call.
 */
export async function forecastToolApproval(
  userId: string,
  toolName: string,
): Promise<ApprovalForecast> {
  if (!isToolName(toolName)) return "none";
  const policyMode = await resolvePolicyMode(userId, toolName);
  const tool = getTool(toolName);

  if (!tool) return "none";

  // The `confirm` and `question` arms always park (ADR-0099, ADR-0113).
  if (STAGING_ARM[tool.staging]?.forcesApproval) return "always";

  // No validated input here, so assume a dynamic tier may gate.
  if (tool.resolvesRiskTier) return "waivable";

  return toolRequiresApproval(policyMode, tool.riskTier) ? "waivable" : "none";
}

/**
 * Whether every call of `toolName` parks for approval under `policyMode`, whatever its input.
 * The model skips its own confirm question for a tool this marks, so it must never mark a tool
 * that a call can run without a card. It under-reports instead: a dynamic tier that can rise
 * to `high` counts as not waiting. The opposite bias of `forecastToolApproval`.
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

  // The input picks the policy rule (`mcp.call` on a built-in), so another rule can run it with no card.
  if (tool.resolvesPolicyIntegration) return false;

  // A declared downgrade can take the tier below `high`. The bound call clamps an undeclared one.
  const lowestTier = tool.riskTierDowngradeReason === undefined ? tool.riskTier : "no_risk";

  return toolRequiresApproval(policyMode, lowestTier);
}
