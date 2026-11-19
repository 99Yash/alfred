/**
 * The approval rule (ADR-0034, ADR-0069) and its two predictors. Dispatch applies the rule to
 * each call. The batch scheduler and the connected summary predict it before a call, so the
 * prompt, the scheduler, and the gate cannot disagree. Chat full autonomy is not part of the
 * forecast: the round reads it once, and dispatch reads it live for each call. The route quote of
 * a discovery hit (`route-quote.ts`) is not a forecast: it applies `callRequiresApproval` itself,
 * with Full Autonomy read live.
 */

import {
  integrationFromToolName,
  isToolName,
  type ApprovalCause,
  type ApprovalSetting,
  type IntegrationSlug,
  type PolicyMode,
  type ToolName,
  type ToolReadClass,
  type ToolRiskTier,
} from "@alfred/contracts";
import type { Fix } from "@alfred/contracts/app-errors";
import { resolvePolicyMode, type PolicyDecision } from "@alfred/assistant/action-policies";
import type { ReadFacts } from "./read-route";
import { STAGING_ARM } from "./internal/dispatch/staging-arm";
import { getTool, type ToolStagingPolicy } from "./internal/registry";

/**
 * The approval rule (ADR-0130 decision 1). The `high` tier always asks: "Auto" must not authorize
 * an irreversible action, such as a real email send. Under `gated`, a confirmed `ordinary` read
 * runs with no card, and every other call asks: a write, a `secret` read, and a read with no
 * class. `readClass` is `ReadFacts.readClass`: the class of a confirmed read, else `undefined`.
 * Dispatch, both predictors, and the route quote use this one gate.
 */
export function toolRequiresApproval(
  policyMode: PolicyMode,
  riskTier: ToolRiskTier,
  readClass: ToolReadClass | undefined,
): boolean {
  if (riskTier === "high") return true;

  return policyMode === "gated" && readClass !== "ordinary";
}

/**
 * The live approval of one call, which the read route takes as its input (ADR-0124 amendment
 * 2026-11-18): the staging arm, the rule and the tier, and the thread's Full Autonomy. `join` and
 * `fast_path` return before the gate, so they never wait. A forced arm waits whatever the rest says.
 * Dispatch reads Full Autonomy only when the rule would gate, so a caller may pass `false` then.
 */
export function callRequiresApproval(args: {
  staging: ToolStagingPolicy;
  policyMode: PolicyMode;
  riskTier: ToolRiskTier;
  readClass: ToolReadClass | undefined;
  fullAutonomy: boolean;
}): boolean {
  const arm = STAGING_ARM[args.staging];

  if (arm === null) return false;

  if (arm.forcesApproval) return true;

  return toolRequiresApproval(args.policyMode, args.riskTier, args.readClass) && !args.fullAutonomy;
}

/**
 * `mcp.call` reaches every server, so one override on it would cover each server at once. Its
 * card names the integration mode of the server's provider instead.
 */
const MCP_CALL_TOOL = "mcp.call" satisfies ToolName;

/** The facts of one call that waits on a card, for `approvalCause`. */
export interface ApprovalCauseFacts {
  staging: ToolStagingPolicy;
  toolName: ToolName;
  /** The mode and the setting that set it (`resolvePolicyDecision`). */
  policy: PolicyDecision;
  /** The integration whose rule governs the call: the provider of a built-in `mcp.call`. */
  policyIntegration: IntegrationSlug;
  riskTier: ToolRiskTier;
  /** The read facts of the call. Dispatch reads them under `gated` below `high`, else `undefined`. */
  readFacts: Pick<ReadFacts, "read" | "readClass"> | undefined;
  /** The run has a chat thread, so Full Autonomy for the thread can remove the card. */
  onThread: boolean;
}

/**
 * Why a call waits on a card, and the closed list of settings that remove the card (ADR-0130
 * decision 4). It follows `toolRequiresApproval`, so a listed setting removes the card for the
 * same call. `null` when the call does not wait, or when no setting removes the card: a forced
 * arm (`confirm`, `question`), or a `high` call outside a chat thread.
 */
export function approvalCause(facts: ApprovalCauseFacts): ApprovalCause | null {
  const arm = STAGING_ARM[facts.staging];

  if (arm === null || arm.forcesApproval) return null;

  const readClass = facts.readFacts?.readClass;

  if (!toolRequiresApproval(facts.policy.mode, facts.riskTier, readClass)) return null;

  const fullAutonomy: ApprovalSetting[] = facts.onThread ? [{ kind: "full_autonomy" }] : [];

  if (facts.riskTier === "high") {
    return fullAutonomy.length > 0 ? { cause: "high_risk", settings: fullAutonomy } : null;
  }

  const alwaysAllow: ApprovalSetting = { kind: "always_allow", toolName: facts.toolName };

  // An override on the tool beats the integration mode, so only "Always allow" changes it.
  // Overrides apply only under the tool's own integration (`resolvePolicyDecision`).
  const policySettings: ApprovalSetting[] =
    facts.policy.source === "tool_override"
      ? [alwaysAllow]
      : [
          { kind: "integration_mode", integration: facts.policyIntegration },
          ...(facts.policyIntegration === integrationFromToolName(facts.toolName) &&
          facts.toolName !== MCP_CALL_TOOL
            ? [alwaysAllow]
            : []),
        ];

  return {
    cause: causeOfGatedCall(facts.readFacts),
    settings: [...policySettings, ...fullAutonomy],
  };
}

/** The cause as the model reads it: the cause, and a `change_setting` fix with the settings. */
export interface ApprovalCauseFact {
  cause: ApprovalCause["cause"];
  fix: Extract<Fix, { kind: "change_setting" }>;
}

export function approvalCauseFact(cause: ApprovalCause): ApprovalCauseFact {
  return { cause: cause.cause, fix: { kind: "change_setting", settings: cause.settings } };
}

function causeOfGatedCall(
  readFacts: ApprovalCauseFacts["readFacts"],
): Exclude<ApprovalCause["cause"], "high_risk"> {
  if (readFacts?.read !== true) return "may_write";

  return readFacts.readClass === "secret" ? "secret_read" : "unclassified_read";
}

/**
 * A declared script read (`codeModeRead`). In a `code_run` run, the connected summary gives such
 * a read no approval label, because a run-start label would pick its route (ADR-0124 amendment
 * 2026-11-18).
 */
export function isDeclaredScriptRead(toolName: ToolName): boolean {
  return getTool(toolName)?.codeModeRead === true;
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

  return toolRequiresApproval(policyMode, tool.riskTier, tool.readClass) ? "waivable" : "none";
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

  return toolRequiresApproval(policyMode, lowestTier, tool.readClass);
}
