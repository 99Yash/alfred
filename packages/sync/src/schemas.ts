import {
  INTEGRATION_SLUGS,
  POLICY_MODES,
  TOOL_RISK_TIERS,
  artifactContentSchema,
  artifactFormatSchema,
  artifactKindSchema,
  artifactStatusSchema,
  briefingGatherSchema,
  briefingClosedLoopSchema,
  briefingSendDecisionSchema,
  briefingSlotSchema,
  briefingStatusSchema,
  chatAttachmentStatusSchema,
  chatErrorKindSchema,
  chatMessageUsageSchema,
  fullBriefingSchema,
  isIntegrationSlug,
  isRecord,
  isToolName,
  jsonRecordSchema,
  jsonValueSchema,
  memorySourceSchema,
  significanceBandSchema,
  todoCreatedBySchema,
  todoExecutorSchema,
  todoKindSchema,
  todoSourcesSchema,
  todoStatusSchema,
  toolNameSchema,
  triageCategorySchema,
  workflowBlockedSchema,
  chatConnectNudgeSchema,
  type IntegrationRule,
  type IntegrationRules,
  type MemorySource,
  type PolicyMode,
  type ToolName,
} from "@alfred/contracts";
import { isoDateTimeStringSchema, runStatusSchema, workflowTriggerSchema } from "@alfred/contracts";
import { z } from "zod";

// Do not re-export `isoDateTimeStringSchema`; import it from `@alfred/contracts`.
export { jsonRecordSchema, memorySourceSchema, type MemorySource };

/**
 * A stored fact value. Do not narrow it: stored values already use the full shape.
 * Do not give it to a model; use {@link modelFactValueSchema}.
 */
export const factValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(jsonValueSchema),
  jsonRecordSchema,
]);

export type FactValue = z.infer<typeof factValueSchema>;

const factValueScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * A non-recursive subset of {@link factValueSchema} for model output.
 * Google's schema converter cannot express a recursive `$ref` and throws,
 * so Gemini extraction failed silently.
 */
export const modelFactValueSchema = z.union([
  factValueScalarSchema,
  z.array(factValueScalarSchema),
  z.record(z.string(), factValueScalarSchema),
]);

export type ModelFactValue = z.infer<typeof modelFactValueSchema>;

export const preferenceValueSchema = z.union([factValueSchema, z.null()]);

export type PreferenceValue = z.infer<typeof preferenceValueSchema>;

export { toolNameSchema };

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
  value: preferenceValueSchema,
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
  /** Display-only subset of `agent_runs.trigger`. Never the raw payload or document ids (ADR-0034). */
  trigger: z.object({
    kind: z.string(),
    source: z.string().nullish(),
    type: z.string().nullish(),
    /** The provider kind a raw event run fired under (#990). */
    rawKind: z.string().nullish(),
  }),
  /** The run's brief, cut to 280 chars by the server. */
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

export const syncedBriefingSchema = z.object({
  id: z.string(),
  userId: z.string(),
  briefingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: briefingSlotSchema,
  timezone: z.string(),
  status: briefingStatusSchema,
  sendDecision: briefingSendDecisionSchema.nullable(),
  gateReason: z.string().nullable(),
  gather: briefingGatherSchema.nullable(),
  closedLoops: z.array(briefingClosedLoopSchema).default([]),
  breakingSummary: z.string().nullable(),
  fullBriefing: fullBriefingSchema.nullable(),
  model: z.string().nullable(),
  composeFallback: z.boolean(),
  emailSendId: z.string().nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});

export type SyncedBriefing = z.infer<typeof syncedBriefingSchema>;

/** A todo (ADR-0050). The pull window drops `dismissed` rows and keeps `done` rows for 2 days. */
export const syncedTodoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: todoStatusSchema,
  createdBy: todoCreatedBySchema,
  executor: todoExecutorSchema,
  kind: todoKindSchema,
  assist: z.string().nullable(),
  sources: todoSourcesSchema,
  agentRunId: z.string().nullable(),
  completedAt: isoDateTimeStringSchema.nullable(),
  position: z.number().nullable(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});

export type SyncedTodo = z.infer<typeof syncedTodoSchema>;

export const syncedChatThreadSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().nullable(),
  lastMessageAt: isoDateTimeStringSchema.nullable(),
  // Defaulted so older cached rows still parse.
  pinned: z.boolean().default(false),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});

export type SyncedChatThread = z.infer<typeof syncedChatThreadSchema>;

/** A tool card on a finished assistant turn. */
export const syncedChatToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  argsPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  /** `resultPreview` was pruned. A pruned preview still parses, so readers cannot tell otherwise. */
  resultTruncated: z.boolean().optional(),
  /** The narration segment this call follows. Defaulted so older rows still parse. */
  segmentIndex: z.number().default(0),
  /**
   * Set only on a connection-health bounce, so a reload can offer the repair again.
   * `null` means an unreadable nudge. The `catch` stops it from dropping the whole message.
   */
  connectNudge: chatConnectNudgeSchema.nullable().optional().catch(null),
});

export type SyncedChatToolCall = z.infer<typeof syncedChatToolCallSchema>;

/** A closed narration segment captured on a finished assistant turn. */
export const syncedChatNarrationSchema = z.object({
  index: z.number(),
  text: z.string(),
});

export type SyncedChatNarration = z.infer<typeof syncedChatNarrationSchema>;

/** A chat message. The client writes `user` rows; the worker writes `assistant` rows when a turn ends. */
export const syncedChatMessageSchema = z.object({
  id: z.string(),
  userId: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  // The `.default(null)` fields below let older cached rows still parse.
  reasoning: z.string().nullable().default(null),
  reasoningMs: z.number().nullable().default(null),
  status: z.enum(["complete", "failed"]),
  /**
   * Why a failed turn failed. Null on complete rows, on older rows, and on a kind this
   * build does not know (a stale tab after a deploy, or a server rolled back past a
   * newer row), so the row still parses and renders the generic failure copy.
   */
  errorKind: chatErrorKindSchema.nullable().default(null).catch(null),
  toolCalls: z.array(syncedChatToolCallSchema).nullable(),
  /** Interleaved with `toolCalls` by `segmentIndex`. */
  narration: z.array(syncedChatNarrationSchema).nullable().default(null),
  usage: chatMessageUsageSchema.nullable().default(null),
  runId: z.string().nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});

export type SyncedChatMessage = z.infer<typeof syncedChatMessageSchema>;

/**
 * Display metadata for one chat attachment (ADR-0065). Bytes load through
 * `/api/chat/attachments/:id/content`. The storage key and `degraded_text` stay on the server.
 */
export const syncedChatAttachmentSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  position: z.number().int().nonnegative().default(0),
  status: chatAttachmentStatusSchema,
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});

export type SyncedChatAttachment = z.infer<typeof syncedChatAttachmentSchema>;

/**
 * An agent artifact (ADR-0075). The boss rewrites the row as it writes, so pages appear live.
 * `content` is null on a new `generating` row. `storageKey` stays on the server.
 */
export const syncedArtifactSchema = z.object({
  id: z.string(),
  userId: z.string(),
  threadId: z.string(),
  runId: z.string().nullable().default(null),
  messageId: z.string().nullable().default(null),
  kind: artifactKindSchema,
  format: artifactFormatSchema.nullable().default(null),
  title: z.string(),
  status: artifactStatusSchema,
  content: artifactContentSchema.nullable().default(null),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});

export type SyncedArtifact = z.infer<typeof syncedArtifactSchema>;

/**
 * A thread's triage tag (ADR-0025). Split on `source`: only `auto` tags carry classifier
 * fields, and only `user` tags carry `overriddenAt`.
 */
const triageTagSharedSchema = {
  /** Gmail `source_thread_id`. Also the IDB key. */
  threadId: z.string(),
  userId: z.string(),
  category: triageCategorySchema,
  /** The latest classified `documents.id`. Not a foreign key. */
  documentId: z.string().nullable(),
  /** Null until the label is reconciled. */
  appliedLabelId: z.string().nullable(),
  /** Sender significance at classify time (ADR-0064). Only dims the row; never changes the tag. */
  senderSignificanceBand: significanceBandSchema.nullable().default(null),
  rowVersion: z.number(),
  updatedAt: isoDateTimeStringSchema.nullable(),
};

export const syncedTriageTagSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("auto"),
    confidence: z.number().min(0).max(1),
    rationale: z.string().nullable(),
    classifiedAt: isoDateTimeStringSchema,
    ...triageTagSharedSchema,
  }),
  z.object({
    source: z.literal("user"),
    overriddenAt: isoDateTimeStringSchema,
    ...triageTagSharedSchema,
  }),
]);

export type SyncedTriageTag = z.infer<typeof syncedTriageTagSchema>;

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

function normalizeIntegrationRules(rawRules: unknown): IntegrationRules {
  if (!isRecord(rawRules)) return {};
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

/** A workflow. Built-ins sync too, but the editor treats them as read-only. */
export const syncedWorkflowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  trigger: workflowTriggerSchema,
  brief: z.string().nullable(),
  allowedIntegrations: z.array(z.string()),
  currentRevisionId: z.string().nullable(),
  publishedRevisionId: z.string().nullable(),
  blocked: workflowBlockedSchema.nullable(),
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
