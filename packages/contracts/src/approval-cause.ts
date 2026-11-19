/**
 * Why a call waits on an approval card, and the settings that remove the card (ADR-0130 decision
 * 4). Code supplies these facts. The model writes the words, and the web shows the links.
 */
import { z } from "zod";
import { INTEGRATION_SLUGS } from "./integrations";
import { toolNameSchema } from "./tools";

/**
 * One setting that removes a card. A closed list:
 * - `integration_mode`: the mode of the integration on its integrations page.
 * - `always_allow`: "Always allow" for this one tool.
 * - `full_autonomy`: Full Autonomy for the chat thread.
 */
export const approvalSettingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("integration_mode"), integration: z.enum(INTEGRATION_SLUGS) }),
  z.object({ kind: z.literal("always_allow"), toolName: toolNameSchema }),
  z.object({ kind: z.literal("full_autonomy") }),
]);

export type ApprovalSetting = z.infer<typeof approvalSettingSchema>;

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

export const approvalCauseSchema = z.object({
  cause: z.enum(APPROVAL_CAUSE_KINDS),
  settings: z.array(approvalSettingSchema).min(1),
});

export type ApprovalCause = z.infer<typeof approvalCauseSchema>;

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
  /** The integration mode that runs a call with no card. */
  integrationAuto: "Auto",
  /** The integration mode that asks first. */
  integrationGated: "Gated",
  /** The menu in the head of an approval card that waits. A decided card does not show it. */
  permissions: "Permissions",
  /** The switch in the Permissions menu that sets an override on the tool. */
  alwaysAllowAction: "Always allow this action",
} as const;
