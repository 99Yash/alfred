/**
 * Why a call waited on an approval card, and the settings that remove such a card (ADR-0130
 * decision 4, amendment (c)). The reason is a fact of the call, so the staging row keeps it. The
 * settings are a fact of current policy, so `approvalSettings` derives them each time a surface
 * shows them. Code supplies these facts. The model writes the words, and the web shows the links.
 */
import { z } from "zod";
import { enumGuard } from "./guards";
import {
  INTEGRATION_SLUGS,
  LIVE_PROVIDER_SLUGS,
  type IntegrationSlug,
  type LiveProviderSlug,
} from "./integrations";
import {
  integrationFromToolName,
  mcpServerToolRefSchema,
  serverToolRuleOf,
  toolNameSchema,
  type ApprovalModeSource,
  type IntegrationRules,
  type McpServerToolRef,
  type ToolName,
} from "./tools";

/**
 * The integrations whose page has the mode control (`ProviderPolicy` renders only for a live
 * provider). The approval settings and the policy writer (`policySetIntegrationModeArgsSchema`)
 * use this one list.
 */
export const APPROVAL_MODE_SLUGS: readonly LiveProviderSlug[] = LIVE_PROVIDER_SLUGS;

export const integrationTakesMode = enumGuard(APPROVAL_MODE_SLUGS);

/**
 * A tool that can take an "Always allow" override: a tool of an integration that takes a mode.
 * `system.*` never gates, and one override on `mcp.call` would cover every server.
 */
export function toolTakesOverride(toolName: ToolName): boolean {
  return integrationTakesMode(integrationFromToolName(toolName));
}

/**
 * One setting that removes a card. A closed list, narrowest first. Only `approvalSettings` makes
 * one, from a stored reason, so no boundary parses it.
 * - `always_allow`: "Always allow" for this one tool (`toolTakesOverride`).
 * - `always_allow_server_tool`: "Always allow" for this one tool on one MCP server, at the call's
 *   descriptor. `integration` holds the rule: the server's provider, else `mcp`.
 * - `integration_mode`: the mode of the integration on its integrations page.
 * - `full_autonomy`: Full Autonomy for the chat thread.
 */
export type ApprovalSetting =
  | { kind: "always_allow"; toolName: ToolName }
  | { kind: "always_allow_server_tool"; integration: IntegrationSlug; serverTool: McpServerToolRef }
  | { kind: "integration_mode"; integration: LiveProviderSlug }
  | { kind: "full_autonomy" };

/**
 * Why the call waits:
 * - `high_risk`: the tier is `high`. Only Full Autonomy removes the card.
 * - `may_write`: the mode asks first, and Alfred cannot confirm that the call only reads.
 * - `secret_read`: the mode asks first, and the read can return a secret.
 * - `unclassified_read`: the mode asks first, and no code and no owner review classify the read.
 */
export const APPROVAL_CAUSE_KINDS = [
  "high_risk",
  "may_write",
  "secret_read",
  "unclassified_read",
] as const;

export type ApprovalCauseKind = (typeof APPROVAL_CAUSE_KINDS)[number];

const APPROVAL_MODE_SOURCES = [
  "tool_override",
  "server_tool",
  "integration",
  "default",
] as const satisfies readonly ApprovalModeSource[];

/**
 * The reason why one call waited, as dispatch decided it. The staging row keeps it.
 * - A `high` call names only the tool: no policy setting removes its card.
 * - Any other call names the integration whose rule governs it (the provider of a built-in
 *   `mcp.call`), and the setting that supplied the mode.
 * - `serverTool`: the server tool of an `mcp.call` whose descriptor dispatch resolved. Absent for
 *   any other call, and on a row from before the rule on one server tool.
 */
export const approvalReasonSchema = z.discriminatedUnion("cause", [
  z.object({ cause: z.literal("high_risk"), toolName: toolNameSchema }),
  z.object({
    cause: z.enum(APPROVAL_CAUSE_KINDS).exclude(["high_risk"]),
    toolName: toolNameSchema,
    integration: z.enum(INTEGRATION_SLUGS),
    source: z.enum(APPROVAL_MODE_SOURCES),
    serverTool: mcpServerToolRefSchema.optional(),
  }),
]);

export type ApprovalReason = z.infer<typeof approvalReasonSchema>;

/** The policy facts that `approvalSettings` reads. */
export interface ApprovalPolicyView {
  integrationRules: IntegrationRules;
}

/**
 * The settings that remove a card with this reason under current policy (ADR-0130 amendment (c)),
 * narrowest first. Each surface calls it when it shows the settings, so a list is never out of
 * date. `onThread`: the call ran in a chat thread, so Full Autonomy for the thread applies.
 * - A `high` card lists only Full Autonomy.
 * - "Always allow" applies only to the tool's own integration (`resolvePolicyDecision`).
 * - On an MCP server, "Always allow" is the rule on the one server tool (`serverTool`). One rule
 *   on `mcp.call` for every server is not offered.
 * - A current rule on the tool or on the server tool beats the integration mode, so the mode is
 *   not listed then.
 * - The integration mode is listed only when the integration page has the control.
 * - The global default is not listed: it changes every integration.
 */
export function approvalSettings(
  reason: ApprovalReason,
  policy: ApprovalPolicyView,
  onThread: boolean,
): ApprovalSetting[] {
  const fullAutonomy: ApprovalSetting[] = onThread ? [{ kind: "full_autonomy" }] : [];

  if (reason.cause === "high_risk") return fullAutonomy;

  const { integration, serverTool } = reason;
  const ownIntegration = integrationFromToolName(reason.toolName) === integration;

  const overrideGoverns =
    serverTool === undefined
      ? ownIntegration &&
        policy.integrationRules[integration]?.toolOverrides?.[reason.toolName] !== undefined
      : serverToolRuleOf(policy.integrationRules, integration, serverTool) !== undefined;

  return [
    ...(serverTool === undefined
      ? []
      : [{ kind: "always_allow_server_tool", integration, serverTool } as const]),
    ...(ownIntegration && toolTakesOverride(reason.toolName)
      ? [{ kind: "always_allow", toolName: reason.toolName } as const]
      : []),
    ...(!overrideGoverns && integrationTakesMode(reason.integration)
      ? [{ kind: "integration_mode", integration: reason.integration } as const]
      : []),
    ...fullAutonomy,
  ];
}

/**
 * The labels of the controls that change an approval setting. The web shows them, and the model
 * fact (`approvalCauseFact`) names them, so a renamed control renames both.
 */
export const APPROVAL_CONTROL_LABELS = {
  /** The mode in the approval mode menu of the message box toolbar. */
  fullAutonomy: "Full autonomy",
  /** The button under a reply that turns on Full autonomy for the chat. */
  fullAutonomyButton: "Full Autonomy for this chat",
  /** The section of an integration page that sets its mode and lists its tool overrides. */
  approvalPolicy: "Approval policy",
  /** The list of exceptions in the approval policy section of an integration page. */
  actionExceptions: "Action exceptions",
  /** The item of an MCP connection menu that opens the server's tools and their approval policy. */
  serverTools: "View tools",
  /** The integration mode that runs a call with no card. */
  integrationAuto: "Auto",
  /** The integration mode that asks first. */
  integrationGated: "Gated",
  /** The menu in the head of an approval card that waits. A decided card does not show it. */
  permissions: "Permissions",
  /** The switch in the Permissions menu that sets an override on the tool. */
  alwaysAllowAction: "Always allow this action",
} as const;
