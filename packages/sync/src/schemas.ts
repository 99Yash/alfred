import {
  INTEGRATION_SLUGS,
  POLICY_MODES,
  TOOL_RISK_TIERS,
  isIntegrationSlug,
  isToolName,
  type IntegrationRule,
  type IntegrationRules,
  type PolicyMode,
  type ToolName,
} from "@alfred/contracts";
import { runStatusSchema, workflowTriggerSchema } from "@alfred/schemas";
import { z } from "zod";

export const isoDateTimeStringSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "must be a valid date-time string",
  });

export const jsonRecordSchema = z.record(z.string(), z.unknown());

export const memorySourceSchema = z.object({
  kind: z.enum(["document", "chunk", "tool_call", "cold_start", "user", "agent"]),
  id: z.string().optional(),
  meta: jsonRecordSchema.optional(),
});
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const factValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  jsonRecordSchema,
]);
export type FactValue = z.infer<typeof factValueSchema>;

export const preferenceValueSchema = z.union([factValueSchema, z.null()]);
export type PreferenceValue = z.infer<typeof preferenceValueSchema>;

export const toolNameSchema = z.custom<ToolName>(
  (value) => typeof value === "string" && isToolName(value),
  { message: "must be a known tool name" },
);

export const syncedNoteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  text: z.string(),
  createdAt: isoDateTimeStringSchema,
  rowVersion: z.number(),
});
export type SyncedNote = z.infer<typeof syncedNoteSchema>;

export const syncedPreferenceSchema = z.object({
  key: z.string(),
  userId: z.string(),
  value: z.unknown(),
  source: memorySourceSchema,
  rowVersion: z.number(),
});
export type SyncedPreference = z.infer<typeof syncedPreferenceSchema>;

export const syncedSkillSchema = z.object({
  id: z.string(),
  userId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  currentRevisionId: z.string().nullable(),
  status: z.string(),
  isBuiltin: z.boolean(),
  lastInvokedAt: isoDateTimeStringSchema.nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});
export type SyncedSkill = z.infer<typeof syncedSkillSchema>;

export const syncedSkillRevisionSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  userId: z.string(),
  kind: z.string(),
  body: z.string(),
  metadata: jsonRecordSchema,
  createdByRunId: z.string().nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
});
export type SyncedSkillRevision = z.infer<typeof syncedSkillRevisionSchema>;

export const syncedSkillRunSchema = z.object({
  id: z.string(),
  skillId: z.string(),
  userId: z.string(),
  kind: z.string(),
  agentRunId: z.string(),
  status: runStatusSchema,
  producedRevisionId: z.string().nullable(),
  rowVersion: z.number(),
  startedAt: isoDateTimeStringSchema,
  endedAt: isoDateTimeStringSchema.nullable(),
});
export type SyncedSkillRun = z.infer<typeof syncedSkillRunSchema>;

export const syncedActionStagingSchema = z.object({
  id: z.string(),
  userId: z.string(),
  runId: z.string(),
  workflowSlug: z.string(),
  /** Display name from `workflows.name`; falls back to the slug. */
  workflowName: z.string(),
  /**
   * Narrowed, display-only projection of `agent_runs.trigger` — enough for the
   * card to say "Run now" vs "Triggered by Gmail message". Never the raw
   * payload or document ids (ADR-0034 amendment 2026-05-31).
   */
  trigger: z.object({
    kind: z.string(),
    source: z.string().nullish(),
    type: z.string().nullish(),
  }),
  /** Server-truncated (~280c) preview of the run's brief, for provenance. */
  brief: z.string().nullable(),
  stepId: z.string(),
  toolCallId: z.string(),
  toolName: toolNameSchema,
  integration: z.enum(INTEGRATION_SLUGS),
  riskTier: z.enum(TOOL_RISK_TIERS),
  proposedInput: z.unknown(),
  requiresApproval: z.boolean(),
  status: z.literal("pending"),
  expiresAt: isoDateTimeStringSchema.nullable(),
  notifyAfterAt: isoDateTimeStringSchema.nullable(),
  notifiedAt: isoDateTimeStringSchema.nullable(),
  recentRejection: z
    .object({
      runId: z.string(),
      reason: z.string().nullable(),
      decidedAt: isoDateTimeStringSchema,
    })
    .nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});
export type SyncedActionStaging = z.infer<typeof syncedActionStagingSchema>;

export const syncedFactSchema = z.object({
  id: z.string(),
  userId: z.string(),
  key: z.string(),
  value: z.unknown(),
  confidence: z.number(),
  status: z.enum(["proposed", "confirmed"]),
  source: memorySourceSchema,
  validFrom: isoDateTimeStringSchema,
  validUntil: isoDateTimeStringSchema.nullable(),
  supersedesId: z.string().nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});
export type SyncedFact = z.infer<typeof syncedFactSchema>;

export const policyModeSchema = z.enum(POLICY_MODES);

const rawIntegrationRuleSchema = z.object({
  mode: policyModeSchema,
  toolOverrides: z.record(z.string(), policyModeSchema).optional(),
});

function normalizeToolOverrides(
  toolOverrides: Record<string, PolicyMode> | undefined,
): IntegrationRule["toolOverrides"] {
  const filtered: Partial<Record<ToolName, PolicyMode>> = {};
  for (const [toolName, mode] of Object.entries(toolOverrides ?? {})) {
    if (isToolName(toolName)) filtered[toolName] = mode;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export const integrationRuleSchema: z.ZodType<IntegrationRule> = rawIntegrationRuleSchema.transform(
  (rule) => {
    const toolOverrides = normalizeToolOverrides(rule.toolOverrides);
    return toolOverrides ? { mode: rule.mode, toolOverrides } : { mode: rule.mode };
  },
);

function normalizeIntegrationRules(rawRules: Record<string, unknown>): IntegrationRules {
  const rules: IntegrationRules = {};
  for (const [slug, rawRule] of Object.entries(rawRules)) {
    if (!isIntegrationSlug(slug)) continue;
    const result = integrationRuleSchema.safeParse(rawRule);
    if (result.success) rules[slug] = result.data;
  }
  return rules;
}

export const syncedActionPolicySchema = z.object({
  userId: z.string(),
  defaultMode: policyModeSchema,
  integrationRules: z.record(z.string(), z.unknown()).transform(normalizeIntegrationRules),
  approvalNotifyDelayMs: z.number(),
  rowVersion: z.number(),
});
export type SyncedActionPolicy = z.infer<typeof syncedActionPolicySchema>;

export const workflowStatusSchema = z.enum(["active", "draft", "paused", "archived"]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

/**
 * A workflow row as the web sees it (m13 Phase 8 event-trigger authoring).
 * Built-ins and user-authored rows both sync — the editor only mutates
 * user-authored ones (`isBuiltin === false`); built-ins render read-only.
 * `trigger` carries the full discriminated union so the editor can show
 * Schedule (cron) vs Event pickers from the live value.
 */
export const syncedWorkflowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  trigger: workflowTriggerSchema,
  brief: z.string().nullable(),
  allowedIntegrations: z.array(z.string()),
  status: workflowStatusSchema,
  isBuiltin: z.boolean(),
  lastRunAt: isoDateTimeStringSchema.nullable(),
  lastRunStatus: z.string().nullable(),
  nextRunAt: isoDateTimeStringSchema.nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});
export type SyncedWorkflow = z.infer<typeof syncedWorkflowSchema>;

export type SyncedEntity =
  | SyncedNote
  | SyncedPreference
  | SyncedSkill
  | SyncedSkillRevision
  | SyncedSkillRun
  | SyncedActionStaging
  | SyncedActionPolicy
  | SyncedWorkflow
  | SyncedFact;
