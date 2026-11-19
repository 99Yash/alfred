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
