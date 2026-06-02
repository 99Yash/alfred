/**
 * Morning briefing (ADR-0025 #2).
 *
 * Cron → multi-source query → email send. v1 is inbox-only: the
 * priority list is driven by triage tags from m9; calendar +
 * "relevant updates" land in a follow-up milestone.
 *
 * Module shape mirrors triage:
 *   - `gather`     pure query helpers (no LLM)
 *   - `compose`    v2 structured briefing composer + legacy inbox renderer
 *   - `preferences` timezone + delivery-hour resolution
 *   - `workflow-input` slug + zod schema for callers that enqueue
 */

export {
  resolveBriefingPreferences,
  localDateInTimezone,
  localHourInTimezone,
  isValidTimezone,
  DEFAULT_BRIEFING_TIMEZONE,
  DEFAULT_BRIEFING_DELIVERY_HOUR,
} from "./preferences";
export type { BriefingPreferences } from "./preferences";

export {
  gatherBriefing,
  gatherBriefingDigest,
  PRIORITY_CATEGORIES,
  SUPPRESSED_CATEGORIES,
} from "./gather";
export type {
  BriefingDigest,
  BriefingItem,
  PriorityCategory,
  SuppressedCategory,
  GatherBriefingDigestArgs,
  GatherBriefingArgs,
} from "./gather";

export { composeBriefing, composeInboxBriefing } from "./compose";
export type {
  ComposedBriefing,
  ComposeBriefingArgs,
  ComposedInboxBriefing,
  ComposeInboxBriefingArgs,
} from "./compose";

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
  BRIEFING_WORKFLOW_SLUG,
  DAILY_BRIEFING_WORKFLOW_SLUG,
  briefingWorkflowInputSchema,
  dailyBriefingWorkflowInputSchema,
} from "./workflow-input";
export type { BriefingWorkflowInput, DailyBriefingWorkflowInput } from "./workflow-input";

export {
  listEmailsSinceWatermark,
  readEmailDocument,
  listPriorBriefings,
  fetchLatestWatermark,
  recordBriefingRun,
  type EmailListItem,
  type EmailReadResult,
  type PriorBriefingSummary,
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
