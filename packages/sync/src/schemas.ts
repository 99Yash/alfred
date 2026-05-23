import { INTEGRATION_SLUGS, TOOL_RISK_TIERS, isToolName, type ToolName } from "@alfred/contracts";
import { runStatusSchema } from "@alfred/schemas";
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

export type SyncedEntity =
  | SyncedNote
  | SyncedPreference
  | SyncedSkill
  | SyncedSkillRevision
  | SyncedSkillRun
  | SyncedActionStaging
  | SyncedFact;
