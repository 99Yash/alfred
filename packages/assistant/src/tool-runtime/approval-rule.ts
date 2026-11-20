/**
 * The approval rule (ADR-0034, ADR-0069) and its two predictors. Dispatch applies the rule to
 * each call. The batch scheduler and the connected summary predict it before a call, so the
 * prompt, the scheduler, and the gate cannot disagree. Chat full autonomy is not part of the
 * forecast: the round reads it once, and dispatch reads it live for each call. The route quote of
 * a discovery hit (`route-quote.ts`) is not a forecast: it applies `callRequiresApproval` itself,
 * with Full Autonomy read live.
 */

import {
  APPROVAL_CAUSE_KINDS,
  APPROVAL_CONTROL_LABELS,
  assertNever,
  humanizeToolName,
  INTEGRATION_DISPLAY_NAMES,
  integrationFromToolName,
  isCatalogSlug,
  isToolName,
  approvalSettings,
  type ApprovalCauseKind,
  type ApprovalModeSource,
  type ApprovalReason,
  type ApprovalSetting,
  type IntegrationSlug,
  type PolicyMode,
  type ToolName,
  type ToolReadClass,
  type ToolRiskTier,
} from "@alfred/contracts";
import type { Fix } from "@alfred/contracts/app-errors";
import {
  getResolvedPolicy,
  resolvePolicyMode,
  type PolicyDecision,
} from "@alfred/assistant/action-policies";
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
 * 2026-11-18): the staging arm, the result of the approval rule (`toolRequiresApproval`), and the
 * thread's Full Autonomy. `join` and `fast_path` return before the gate, so they never wait. A
 * forced arm waits whatever the rest says. Dispatch reads Full Autonomy only when the rule gates,
 * so a caller may pass `false` then.
 */
export function callRequiresApproval(args: {
  staging: ToolStagingPolicy;
  ruleGates: boolean;
  fullAutonomy: boolean;
}): boolean {
  const arm = STAGING_ARM[args.staging];

  if (arm === null) return false;

  if (arm.forcesApproval) return true;

  return args.ruleGates && !args.fullAutonomy;
}

/** The facts of one call that the approval rule reads, for `approvalReasonOf`. */
export interface ApprovalRuleFacts {
  toolName: ToolName;
  /** The mode and the setting that set it (`resolvePolicyDecision`). */
  policy: PolicyDecision;
  /** The integration whose rule governs the call: the provider of a built-in `mcp.call`. */
  policyIntegration: IntegrationSlug;
  riskTier: ToolRiskTier;
  /** The read facts of the call. Dispatch reads them under `gated` below `high`, else `undefined`. */
  readFacts: Pick<ReadFacts, "read" | "readClass"> | undefined;
}

/**
 * The approval rule for one call, with its reason (ADR-0130 amendment (c)). `null`: the rule does
 * not gate the call. Dispatch decides the card from this one result, so the reason and the card
 * cannot disagree. The staging arm and Full Autonomy apply after it (`callRequiresApproval`).
 */
export function approvalReasonOf(facts: ApprovalRuleFacts): ApprovalReason | null {
  const readClass = facts.readFacts?.readClass;

  if (!toolRequiresApproval(facts.policy.mode, facts.riskTier, readClass)) return null;

  if (facts.riskTier === "high") return { cause: "high_risk", toolName: facts.toolName };

  // Below `high`, only `gated` gates. A `gated` decision names a setting: `system.*` is `autonomy`.
  if (facts.policy.mode !== "gated") return null;

  return {
    cause: causeOfGatedCall(facts.readFacts),
    toolName: facts.toolName,
    integration: facts.policyIntegration,
    source: facts.policy.source,
  };
}

/**
 * The reason of a card, and the settings that remove such a card under current policy (ADR-0130
 * amendment (c)). The dispatch boundary derives the settings for each result, so they are never
 * out of date. The reason is a durable fact, so it stays when no setting removes the card.
 */
export interface ApprovalCause {
  reason: ApprovalReason;
  settings: ApprovalSetting[];
}

/** The cause of a card now: its reason, and the settings of current policy. `null`: no card. */
export async function approvalCauseNow(
  userId: string,
  reason: ApprovalReason | null,
  onThread: boolean,
): Promise<ApprovalCause | null> {
  if (reason === null) return null;

  return { reason, settings: approvalSettings(reason, await getResolvedPolicy(userId), onThread) };
}

/**
 * One setting as the model reads it (ADR-0130 decision 4). The bare `kind` did not tell the model
 * the label of the control or where it is, so a reply said "approve the request when it comes up"
 * and named no setting. Code gives facts: the labels (`APPROVAL_CONTROL_LABELS`, which the web
 * shows too), the places, the scope, and the causes that the setting removes. The model writes
 * the words. A replay of the recorded turn on Haiku named the setting and its place in 15 of 15
 * replies with these facts, and in 0 of 20 with the bare `kind`.
 *
 * The model reads the fact after the card has a decision, and a decided card does not show its
 * Permissions menu. So a place on a card is the card of the next call.
 */
export type ApprovalSettingFact = ApprovalSetting & {
  /** The label of the control. */
  name: string;
  /** The places where the user can turn the setting on now. */
  where: string[];
  /** What the setting covers: this chat, every call of the integration, or this one action. */
  scope: "this_chat" | "integration" | "this_action";
  /**
   * The causes whose cards the setting removes. A `confirm` card and a question have no cause,
   * and no setting removes them.
   */
  removes: readonly ApprovalCauseKind[];
  /** The place where the user turns the setting off, when it is not in `where`. */
  undoWhere?: string;
};

/** The cause as the model reads it: the cause, and a `change_setting` fix with the settings. */
export interface ApprovalCauseFact {
  cause: ApprovalCauseKind;
  /** The tool whose call waited. */
  toolName: ToolName;
  /** The integration whose rule governs the call: the provider of a built-in `mcp.call`. */
  integration?: IntegrationSlug;
  /**
   * The setting that supplied the mode: the rule on the tool, the integration mode, or the global
   * default. Absent on a `high` card, which no policy setting removes.
   */
  source?: ApprovalModeSource;
  /** Absent when no setting removes the card, for example a `high` card outside a chat. */
  fix?: Omit<Extract<Fix, { kind: "change_setting" }>, "settings"> & {
    settings: ApprovalSettingFact[];
  };
}

export function approvalCauseFact(cause: ApprovalCause): ApprovalCauseFact {
  const { reason } = cause;

  return {
    cause: reason.cause,
    toolName: reason.toolName,
    ...(reason.cause === "high_risk"
      ? {}
      : { integration: reason.integration, source: reason.source }),
    ...(cause.settings.length === 0
      ? {}
      : { fix: { kind: "change_setting", settings: cause.settings.map(approvalSettingFact) } }),
  };
}

const LABELS = APPROVAL_CONTROL_LABELS;

/** A policy setting does not remove a `high` card (`toolRequiresApproval`). Full Autonomy does. */
const BELOW_HIGH_CAUSES = APPROVAL_CAUSE_KINDS.filter((kind) => kind !== "high_risk");

/** The approval policy section of an integration page. Only a catalog slug has a page. */
function approvalPolicyPlace(integration: IntegrationSlug): string | undefined {
  return isCatalogSlug(integration)
    ? `the ${LABELS.approvalPolicy} section of the ${INTEGRATION_DISPLAY_NAMES[integration]} page under Integrations`
    : undefined;
}

function approvalSettingFact(setting: ApprovalSetting): ApprovalSettingFact {
  switch (setting.kind) {
    case "integration_mode": {
      const provider = INTEGRATION_DISPLAY_NAMES[setting.integration];
      const page = approvalPolicyPlace(setting.integration);

      return {
        ...setting,
        name: `${LABELS.integrationAuto} mode for ${provider}`,
        where: [
          ...(page === undefined ? [] : [page]),
          `the "Always allow ${provider}" switch in the ${LABELS.permissions} menu of the next approval card for ${provider}`,
        ],
        scope: "integration",
        removes: BELOW_HIGH_CAUSES,
      };
    }

    case "always_allow": {
      const action = humanizeToolName(setting.toolName);
      const page = approvalPolicyPlace(integrationFromToolName(setting.toolName));

      return {
        ...setting,
        name: LABELS.alwaysAllowAction,
        where: [
          `the "${LABELS.alwaysAllowAction}" switch in the ${LABELS.permissions} menu of the next approval card for ${action}`,
        ],
        scope: "this_action",
        removes: BELOW_HIGH_CAUSES,
        ...(page === undefined ? {} : { undoWhere: page }),
      };
    }

    case "full_autonomy":
      return {
        ...setting,
        name: LABELS.fullAutonomy,
        where: [
          "the approval mode menu in the toolbar of the message box",
          `the "${LABELS.fullAutonomyButton}" button under the reply`,
        ],
        scope: "this_chat",
        removes: APPROVAL_CAUSE_KINDS,
      };
    default:
      return assertNever(setting, "approval setting");
  }
}

function causeOfGatedCall(
  readFacts: ApprovalRuleFacts["readFacts"],
): Exclude<ApprovalCauseKind, "high_risk"> {
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
