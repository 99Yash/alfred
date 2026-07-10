import {
  INTEGRATION_SLUGS,
  POLICY_MODES,
  TOOL_RISK_TIERS,
  artifactContentSchema,
  artifactFormatSchema,
  artifactKindSchema,
  artifactStatusSchema,
  briefingGatherSchema,
  briefingSendDecisionSchema,
  briefingSlotSchema,
  briefingStatusSchema,
  chatAttachmentStatusSchema,
  chatErrorKindSchema,
  fullBriefingSchema,
  isIntegrationSlug,
  isToolName,
  jsonRecordSchema,
  memorySourceSchema,
  significanceBandSchema,
  todoCreatedBySchema,
  todoExecutorSchema,
  todoKindSchema,
  todoSourcesSchema,
  todoStatusSchema,
  triageCategorySchema,
  type IntegrationRule,
  type IntegrationRules,
  type MemorySource,
  type PolicyMode,
  type ToolName,
} from "@alfred/contracts";
import { runStatusSchema, workflowTriggerSchema } from "@alfred/contracts";
import { z } from "zod";

export const isoDateTimeStringSchema = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: "must be a valid date-time string",
  });

export { jsonRecordSchema, memorySourceSchema, type MemorySource };

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

/**
 * A todo row as the web sees it (ADR-0050). `dismissed` rows never reach the
 * client; `done` rows linger 2 days (the pull window enforces both). `executor`
 * and `kind` are forward-compat — the rail ignores them in passive v1.
 */
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

/**
 * A chat thread as the web sees it (streaming-chat plan). Ordered by
 * `lastMessageAt` in the sidebar; `title` is null until derived.
 */
export const syncedChatThreadSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().nullable(),
  lastMessageAt: isoDateTimeStringSchema.nullable(),
  /**
   * User-pinned threads float into a "Pinned" group above the date buckets.
   * Defaulted so client rows written before the column existed still parse
   * (they read back as unpinned until the next pull patches them).
   */
  pinned: z.boolean().default(false),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});
export type SyncedChatThread = z.infer<typeof syncedChatThreadSchema>;

/** Tool card captured on a finished assistant turn (mirrors `chat.tool`). */
export const syncedChatToolCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["succeeded", "failed"]),
  argsPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  /**
   * The narration segment this call follows, so a reload interleaves it with
   * the stored narration. Defaulted so rows written before this field existed
   * still parse (they read back at segment 0).
   */
  segmentIndex: z.number().default(0),
});

/** A closed narration segment captured on a finished assistant turn. */
export const syncedChatNarrationSchema = z.object({
  index: z.number(),
  text: z.string(),
});
export type SyncedChatNarration = z.infer<typeof syncedChatNarrationSchema>;

/**
 * A persisted chat message. `user` rows come from the client mutator;
 * `assistant` rows are worker-written on turn completion (the live stream is
 * ephemeral). `toolCalls` lets a reload re-render the cards. `content` is the
 * final text; `reasoning` is the model's thinking (null when none), and
 * `reasoningMs` re-renders the "Thought for Ns" label on reload.
 */
export const syncedChatMessageSchema = z.object({
  id: z.string(),
  userId: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  // Defaulted (not just nullable) so rows cached before these fields existed —
  // older IndexedDB entries, older optimistic user messages — still parse
  // instead of being dropped on read. Output type stays `string | null`.
  reasoning: z.string().nullable().default(null),
  reasoningMs: z.number().nullable().default(null),
  status: z.enum(["complete", "failed"]),
  /**
   * On a failed turn, the user-meaningful failure kind (the bubble maps it to a
   * tailored message + recovery action). Null on complete rows and on legacy
   * failed rows written before this field; defaulted so those still parse.
   */
  errorKind: chatErrorKindSchema.nullable().default(null),
  toolCalls: z.array(syncedChatToolCallSchema).nullable(),
  /**
   * Closed narration segments interleaved with `toolCalls` (by `segmentIndex`)
   * in the activity trail on reload. Defaulted so rows cached before this
   * field existed still parse (they read back with no narration).
   */
  narration: z.array(syncedChatNarrationSchema).nullable().default(null),
  runId: z.string().nullable(),
  rowVersion: z.number(),
  createdAt: isoDateTimeStringSchema,
  updatedAt: isoDateTimeStringSchema.nullable(),
});
export type SyncedChatMessage = z.infer<typeof syncedChatMessageSchema>;

/**
 * One attachment on a user message (ADR-0065). Synced so an uploaded image
 * renders in its bubble on every device and survives reload. Only display
 * metadata + degrade status sync — the raw bytes live in the bucket and are
 * fetched through the auth-gated content proxy
 * (`/api/chat/attachments/:id/content`); the storage key and `degraded_text`
 * are server-only and never cross to the client.
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
 * An agent-produced artifact (ADR-0075), synced so the chat artifact sidebar
 * renders it inline and it survives reload + multi-device. `content` is the
 * full body (markdown or ordered HTML pages) — the boss rewrites the row as it
 * authors (each authoring tool call bumps `rowVersion` + pokes), so the sidebar
 * sees pages appear during generation. `content` is nullable + defaulted so a
 * freshly-created `generating` row (content not yet written) still parses. The
 * server-only `storageKey` (R2 seam) never crosses to the client.
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
 * A thread's triage tag, synced read-only to the client and overridable via
 * the `triageTagOverride` mutator (ADR-0025 #1, rfc-triage-tags.md).
 *
 * Discriminated on `source` so illegal mixes are unrepresentable (Invariants
 * 3 & 4): an `auto` tag carries classifier provenance (`confidence`,
 * `rationale`, `classifiedAt`) and never `overriddenAt`; a `user` tag carries
 * `overriddenAt` and none of the classifier fields — so a confidence score can
 * never render on a tag the user pinned by hand.
 *
 * `id` is the Gmail `source_thread_id` (the IDB key); it travels as `threadId`.
 */
const triageTagSharedSchema = {
  /** Gmail `source_thread_id` — also the IDB key. */
  threadId: z.string(),
  userId: z.string(),
  category: triageCategorySchema,
  /** Soft pointer to the latest classified `documents.id` (client deep-link/join). */
  documentId: z.string().nullable(),
  /** Gmail label id currently on the thread's canonical message, or null pre-reconcile. */
  appliedLabelId: z.string().nullable(),
  /**
   * Sender-significance band at classify time (ADR-0064 / #210) — the rail uses
   * it to dim a low-significance sender's row within its honest category, never
   * to re-tag. `.default(null)` keeps it additive: tag values synced before this
   * field existed parse without it (and old senders re-populate on next classify).
   */
  senderSignificanceBand: significanceBandSchema.nullable().default(null),
  rowVersion: z.number(),
  updatedAt: isoDateTimeStringSchema.nullable(),
};

export const syncedTriageTagSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("auto"),
    /** [0,1] classifier confidence — surfaced for low-confidence soft-confirms. */
    confidence: z.number().min(0).max(1),
    rationale: z.string().nullable(),
    classifiedAt: isoDateTimeStringSchema,
    ...triageTagSharedSchema,
  }),
  z.object({
    source: z.literal("user"),
    /** When the user overrode the tag (Invariant 4: present iff source='user'). */
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
  | SyncedFact
  | SyncedBriefing
  | SyncedTodo
  | SyncedChatThread
  | SyncedChatMessage
  | SyncedChatAttachment
  | SyncedArtifact
  | SyncedTriageTag;
