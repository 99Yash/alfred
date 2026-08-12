export {
  emitReplicachePokes,
  publishEvent,
  type PublishEventArgs,
} from "@alfred/assistant/triggers";
export type { EventFrame, EventKind, EventPayload } from "@alfred/contracts/events";

export {
  cancelRun,
  redeliverRun,
  signalRun,
  startRun,
  startRunInTx,
} from "@alfred/assistant/execution";
export { isUniqueViolation, uniqueViolationConstraint } from "@alfred/db/pg-errors";
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
} from "@alfred/assistant/execution/run-bottlenecks";
export {
  getRunToolSurfaceUsage,
  invokedToolNamesFromTranscript,
  summarizeToolSurfaceUsage,
  type ToolSurfaceUsage,
} from "@alfred/assistant/execution/tool-surface-usage";
export {
  chatMemoryCaptureWorkflow,
  chatTurnWorkflow,
  CHAT_TURN_WORKFLOW_SLUG,
} from "./modules/conversations";
export {
  userAuthoredBriefWorkflow,
  USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
} from "@alfred/assistant/execution/workflows/user-authored-brief";
export {
  assertHandoffSections,
  compactTranscript,
  COMPACTOR_SYSTEM_PROMPT,
  extractHandoffSection,
  HANDOFF_SECTIONS,
  type CompactTranscriptArgs,
  type CompactTranscriptResult,
  type HandoffSection,
} from "@alfred/assistant/execution/run-compaction/index";
export {
  backgroundCompactionThresholdTokens,
  CHAT_MAX_OUTPUT_TOKENS,
  scheduleConversationCompactionIfNeeded,
} from "./modules/conversations";

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
} from "@alfred/assistant/knowledge";

// The knowledge substrate reaches `@alfred/api/backend` through its ONE curated
// barrel (item 15) — the sanctioned observe / recall / contextFor /
// applyCorrection contract plus the genuinely cross-module helpers, nothing
// more. The named observe block above retains precedence over any collision this
// `export *` could introduce. Privileged tooling internals (backfills / smokes)
// resolve through the explicit `@alfred/assistant/knowledge/internal` subpath.
export * from "@alfred/assistant/knowledge";
export {
  runMemoryFinalize,
  runMemoryPickDocuments,
  runMemoryProcess,
  type MemoryExtractionOperationState,
} from "@alfred/assistant/knowledge/workflow-operations";
export {
  enqueueExtractionForUser,
  getMemoryQueue,
  type MemoryJobData,
} from "@alfred/assistant/knowledge/queue";
export { buildMemoryExtractionWorkflow } from "@alfred/assistant/knowledge";

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

export * from "@alfred/assistant/triage";
export {
  suggestTodo,
  type SuggestTodoInput,
  type SuggestTodoResult,
} from "@alfred/assistant/tasks";

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
} from "@alfred/assistant/briefings";

export * from "@alfred/assistant/delivery";
export * from "@alfred/assistant/time";
export * from "@alfred/assistant/execution/scratchpad/index";
export { toolExecuteContext } from "./modules/tools/index";
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
} from "@alfred/assistant/skills";
export {
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  skillDocumentationDedupKey,
  skillDocumentationInputSchema,
  type SkillDocumentationInput,
  collectSkillDocumentationContext,
  type SkillDocumentationContext,
  composeSkillDocumentation,
  type ComposeArgs,
  type ComposedDocumentation,
  composeSkillDocumentationEmail,
  type SkillDocumentationEmailArgs,
  skillDocumentationWorkflow,
} from "@alfred/assistant/skills";
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
} from "@alfred/assistant/tool-runtime";
export {
  expireStaging,
  type ExpireStagingResult,
  type StartApprovalExpiryWorkerOpts,
  type StartApprovalNotificationWorkerOpts,
} from "@alfred/assistant/execution";
export type { MeInboxItem, MeLatestBriefing } from "./modules/me/index";
