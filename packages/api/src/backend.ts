export { publishEvent } from "./events/publish";
export { emitReplicachePokes } from "./events/replicache-events";
export type { EventFrame, EventKind, EventPayload } from "./events/types";

export { cancelRun, redeliverRun, signalRun, startRun, startRunInTx } from "@alfred/assistant/execution";
export { isUniqueViolation, uniqueViolationConstraint } from "./lib/pg-errors";
export type {
  RunStatus,
  Step,
  StepContext,
  StepResult,
  WakeCondition,
  Workflow,
  WorkflowInput,
} from "@alfred/assistant/execution";
export {
  getRunBottleneckSummary,
  summarizeRunBottlenecks,
  type RunBottleneckApiCall,
  type RunBottleneckInput,
  type RunBottleneckStaging,
  type RunBottleneckStep,
  type RunBottleneckSummary,
} from "@alfred/assistant/execution";
export {
  getRunToolSurfaceUsage,
  invokedToolNamesFromTranscript,
  summarizeToolSurfaceUsage,
  type ToolSurfaceUsage,
} from "@alfred/assistant/execution";
export {
  chatMemoryCaptureWorkflow,
  chatTurnWorkflow,
  CHAT_TURN_WORKFLOW_SLUG,
} from "./modules/conversations";
export {
  userAuthoredBriefWorkflow,
  USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
} from "@alfred/assistant/execution";
export {
  assertHandoffSections,
  compactTranscript,
  COMPACTOR_SYSTEM_PROMPT,
  extractHandoffSection,
  HANDOFF_SECTIONS,
  type CompactTranscriptArgs,
  type CompactTranscriptResult,
  type HandoffSection,
} from "@alfred/assistant/execution";
export {
  backgroundCompactionThresholdTokens,
  CHAT_MAX_OUTPUT_TOKENS,
  scheduleConversationCompactionIfNeeded,
} from "./modules/conversations";

export { getIngestionQueue, type IngestionJobData } from "./modules/integrations/index";
export * from "@alfred/assistant/connections";

export {
  activateProjectionVersion,
  appendObservationFamilyMember,
  buildOrgAffiliationObservationInput,
  completeProjectionRun,
  insertObservation,
  isObservationAppendConflict,
  isOrgAffiliationObservationAppendConflict,
  projectGmailKindProfiles,
  recordOrgAffiliationOnConnect,
  recordOrgAffiliationOnCredentialUpsert,
  recordOrgAffiliationOnDisconnect,
  reduceGmailDocument,
  requireEntityIdNamespace,
  startProjectionRun,
  writeProjectionCursor,
  type AppendObservationFamilyMemberResult,
  type BuildOrgAffiliationResult,
  type BuildOrgAffiliationSkipReason,
  type CredentialForAffiliation,
  type GmailDocumentForReduction,
  type GmailReductionIssue,
  type GmailReductionResult,
  type InsertObservationResult,
  type OrgAffiliationStatus,
  type ProjectGmailKindProfilesResult,
  type RecordOrgAffiliationOnCredentialUpsertResult,
  type RecordOrgAffiliationResult,
} from "./modules/knowledge";

// The knowledge substrate reaches `@alfred/api/backend` through its ONE curated
// barrel (item 15) — the sanctioned observe / recall / contextFor /
// applyCorrection contract plus the genuinely cross-module helpers, nothing
// more. The named observe block above retains precedence over any collision this
// `export *` could introduce. Privileged tooling internals (backfills / smokes)
// resolve through the explicit `@alfred/api/modules/knowledge/internal` subpath.
export * from "./modules/knowledge";
export {
  runMemoryFinalize,
  runMemoryPickDocuments,
  runMemoryProcess,
  type MemoryExtractionOperationState,
} from "./modules/knowledge/workflow-operations";
export {
  enqueueExtractionForUser,
  getMemoryQueue,
  type MemoryJobData,
} from "./modules/knowledge/queue";
export { buildMemoryExtractionWorkflow } from "./modules/knowledge/index";

export * from "@alfred/assistant/settings";

// The idle-capture trigger moved to `conversations/idle-capture-queue.ts`; these
// public names are unchanged so `apps/server` and the backfill stay unchanged.
export {
  CHAT_MEMORY_CAPTURE_WORKFLOW_SLUG,
  CHAT_MEMORY_IDLE_MS,
  CHAT_MEMORY_QUEUE_NAME,
  chatMemoryIdleJobId,
  chatMemoryIdleTailJobId,
  chatMemoryJobDataSchema,
  getChatMemoryQueue,
  scheduleThreadIdleExtraction,
  type ChatMemoryJobData,
} from "./modules/conversations";

export * from "./modules/triage/index";
export { suggestTodo, type SuggestTodoInput, type SuggestTodoResult } from "./modules/todos";
export * from "./modules/connections/mcp/index";

export {
  beginBriefing,
  buildSystemPrompt,
  buildBriefingSourcePanels,
  composeBriefing,
  composeInboxBriefing,
  DAILY_BRIEFING_WORKFLOW_SLUG,
  DEFAULT_BRIEFING_DELIVERY_HOUR,
  DEFAULT_BRIEFING_TIMEZONE,
  enqueueBriefingRun,
  fetchLatestWatermark,
  gatherBriefing,
  gatherBriefingDigest,
  gatherBriefingWithSuppressionAudit,
  gatherCalendarContribution,
  gatherDayShape,
  getBriefingQueue,
  isQuietMorning,
  listEmailsSinceWatermark,
  listPriorBriefings,
  markBriefingComposed,
  markBriefingComposing,
  markBriefingFailed,
  markBriefingGathering,
  markBriefingSent,
  markBriefingSuppressed,
  PRIORITY_CATEGORIES,
  readEmailDocument,
  LEGACY_MORNING_BRIEFING_WORKFLOW_SLUG,
  referencesFromSections,
  renderBriefingEmailHtml,
  resolveBriefingPreferences,
  dailyBriefingWorkflow,
  morningBriefingWorkflow,
  runDailyBriefingCompose,
  runDailyBriefingGather,
  runDailyBriefingSend,
  resolveBriefingReferences,
  scorePriorityEmailDemand,
  SUPPRESSED_CATEGORIES,
  dailyBriefingWorkflowInputSchema,
  legacyMorningBriefingWorkflowInputSchema,
  type BeginBriefingResult,
  type BriefingDigest,
  type BriefingInstructionSuppression,
  type BriefingItem,
  type BriefingJobData,
  type BriefingPreferences,
  type BriefingReference,
  type BriefingRow,
  type BriefingSegment,
  type ComposedBriefing,
  type ComposeBriefingArgs,
  type ComposeInboxBriefingArgs,
  type DailyBriefingWorkflowInput,
  type EmailListItem,
  type EmailReadResult,
  type GatherBriefingArgs,
  type GatherBriefingDigestArgs,
  type GatherBriefingWithSuppressionAuditResult,
  type GatherCalendarArgs,
  type LegacyMorningBriefingWorkflowInput,
  type PriorBriefingSummary,
  type PriorityCategory,
  type PriorityEmailDemand,
  type PriorityEmailDemandItem,
  type RenderBriefingEmailArgs,
  type RenderedBriefingEmail,
  type DailyBriefingOperationState,
  type ResolveBriefingReferencesResult,
  type SuppressedCategory,
} from "./modules/briefing/index";

export * from "@alfred/assistant/delivery";
export * from "@alfred/assistant/time";
export {
  bustPolicyCache,
  clearPolicyCacheForTests,
  DEFAULT_APPROVAL_NOTIFY_DELAY_MS,
  getResolvedPolicy,
  publishPolicyBust,
  resolveApprovalNotifyDelayMs,
  resolvePolicyMode,
  type ResolvedPolicy,
} from "./modules/action-policies/index";
export * from "@alfred/assistant/execution/scratchpad";
export {
  clearToolRegistryForTests,
  getTool,
  listToolsForIntegration,
  liveTool,
  registerTool,
  registerTools,
  riskTierCountsForIntegration,
  toolExecuteContext,
  type LiveToolArgs,
  type RegisteredTool,
  type RiskTierCounts,
  type ToolExecuteContext,
  type ToolExecuteContextFields,
} from "./modules/tools/index";
export * from "./modules/dispatch/index";
export {
  collectSkillLearnContext,
  distillResultSchema,
  distillSkill,
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  learnSkillWorkflow,
  learnSkillWorkflowInputSchema,
  MENTION_KINDS,
  parsedMentionSchema,
  parseMentions,
  resolveMentions,
  skillProposalSchema,
  slugifyForUser,
  type DistillResult,
  type DistillSkillArgs,
  type DistillSkillResult,
  type LearnSkillWorkflowInput,
  type MentionKind,
  type MentionRegistry,
  type ParsedMention,
  type SkillLearnContext,
  type SkillProposal,
} from "./modules/skills/index";
export {
  commitSkillRevision,
  finalizeSkillRun,
  recordSkillRun,
  type CommitRevisionArgs,
  type CommitRevisionResult,
  type FinalizeSkillRunArgs,
  type RecordSkillRunArgs,
} from "./modules/skill-revisions/index";
export * from "./modules/skill-documentation/index";
export {
  activateWorkflow,
  canonicalWorkflowDefinition,
  clearWorkflowBlocked,
  computeNextRunAt,
  createWorkflowDraft,
  DEFAULT_WORKFLOW_TIMEZONE,
  dispatchDueCronWorkflows,
  getWorkflowsQueue,
  resolveWorkflowTimezone,
  reviseWorkflow,
  reviseWorkflowFromPatch,
  setWorkflowBlocked,
  setWorkflowStatus,
  validateCronTrigger,
  validateWorkflowDefinition,
  workflowRevisionContentHash,
  type ActivateWorkflowArgs,
  type CreateWorkflowDraftArgs,
  type InactiveWorkflowStatus,
  type ReviseWorkflowArgs,
  type StartWorkflowsWorkerOpts,
  type TickResult,
  type WorkflowDefinitionDraft,
  type WorkflowDefinitionPatch,
  type WorkflowRevisedOutcome,
  type WorkflowRevisionOutcome,
  type WorkflowRevisionProblem,
  type WorkflowRevisionProblemCode,
  type WorkflowServiceFailure,
  type WorkflowServiceResult,
  type WorkflowsJobData,
} from "./modules/workflows/index";
export {
  approvalExpiryJobId,
  approvalNotificationJobId,
  getApprovalExpiryQueue,
  getApprovalNotificationQueue,
  removeApprovalNotificationJob,
  removeApprovalExpiryJob,
  scheduleApprovalExpiryJob,
  scheduleApprovalNotificationJob,
  type ApprovalExpiryJobData,
  type ApprovalNotificationJobData,
} from "./modules/tool-runtime/index";
export {
  expireStaging,
  type ExpireStagingResult,
  type StartApprovalExpiryWorkerOpts,
  type StartApprovalNotificationWorkerOpts,
} from "@alfred/assistant/execution/index";
export type { MeInboxItem, MeLatestBriefing } from "./modules/me/index";
