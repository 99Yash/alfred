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

export { dailyBriefingWorkflowInputSchema } from "./workflow-input";

export type { DailyBriefingWorkflowInput } from "./workflow-input";

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

export { briefingWorker } from "./worker";

export { enqueueBriefingRun } from "./run";

export { buildSystemPrompt } from "./agent/prompt";

export { listActivityInputSchema, type ActivityList } from "./agent/tools";

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
