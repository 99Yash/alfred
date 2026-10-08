/** Daily briefing (ADR-0025 #2, ADR-0048). */

export {
  resolveBriefingPreferences,
  DEFAULT_BRIEFING_TIMEZONE,
  DEFAULT_BRIEFING_DELIVERY_HOUR,
} from "./preferences";

export type { BriefingPreferences } from "./preferences";

export {
  gatherBriefing,
  gatherBriefingWithSuppressionAudit,
  gatherBriefingDigest,
  gatherCalendarContribution,
  gatherDayShape,
  PRIORITY_CATEGORIES,
  SUPPRESSED_CATEGORIES,
} from "./gather";

export type {
  BriefingDigest,
  BriefingItem,
  PriorityCategory,
  SuppressedCategory,
  BriefingInstructionSuppression,
  GatherBriefingDigestArgs,
  GatherBriefingArgs,
  GatherCalendarArgs,
  GatherBriefingWithSuppressionAuditResult,
} from "./gather";

export { composeBriefing, composeInboxBriefing } from "./compose";

export type { ComposedBriefing, ComposeBriefingArgs, ComposeInboxBriefingArgs } from "./compose";

export {
  buildBriefingSourcePanels,
  referencesFromSections,
  renderBriefingEmailHtml,
  resolveBriefingReferences,
  type BriefingReference,
  type BriefingSegment,
  type RenderBriefingEmailArgs,
  type RenderedBriefingEmail,
  type ResolveBriefingReferencesResult,
} from "./references";

export {
  beginBriefing,
  markBriefingComposed,
  markBriefingComposing,
  markBriefingFailed,
  markBriefingGathering,
  markBriefingSent,
  markBriefingSuppressed,
  type BeginBriefingResult,
  type BriefingRow,
} from "./store";

export {
  DAILY_BRIEFING_WORKFLOW_SLUG,
  LEGACY_MORNING_BRIEFING_WORKFLOW_SLUG,
  dailyBriefingWorkflowInputSchema,
  legacyMorningBriefingWorkflowInputSchema,
} from "./workflow-input";

export type {
  DailyBriefingWorkflowInput,
  LegacyMorningBriefingWorkflowInput,
} from "./workflow-input";

export {
  listEmailsSinceWatermark,
  readEmailDocument,
  listPriorBriefings,
  fetchLatestWatermark,
  scorePriorityEmailDemand,
  isQuietMorning,
  type EmailListItem,
  type EmailReadResult,
  type PriorBriefingSummary,
  type PriorityEmailDemand,
  type PriorityEmailDemandItem,
} from "./read";

export {
  startBriefingWorker,
  stopBriefingWorker,
  closeBriefingQueue,
  getBriefingQueue,
  enqueueBriefingRun,
  type BriefingJobData,
} from "./queue";

export { scheduleRepeatableBriefingJobs } from "./repeatable";

export { buildSystemPrompt } from "./agent/prompt";

export {
  auditComposedBriefing,
  describeOpenAskViolation,
  downgradeOpenAsks,
  filterDroppedCitations,
  findOpenAskViolations,
  type BriefingBodyField,
  type ClosedObjectFact,
  type ComposedBriefingBody,
  type OpenAskViolation,
} from "./open-ask-guard";

export {
  runDailyBriefingCompose,
  runDailyBriefingGather,
  runDailyBriefingSend,
  type DailyBriefingOperationState,
} from "./workflow-operations";

// Registered with execution by `apps/server/src/builtins/index.ts`.
export { dailyBriefingWorkflow } from "./daily-briefing";

export { morningBriefingWorkflow } from "./legacy-morning-briefing";
