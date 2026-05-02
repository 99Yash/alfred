/**
 * Morning briefing (ADR-0025 #2).
 *
 * Cron → multi-source query → email send. v1 is inbox-only: the
 * priority list is driven by triage tags from m9; calendar +
 * "relevant updates" land in a follow-up milestone.
 *
 * Module shape mirrors triage:
 *   - `gather`     pure query helpers (no LLM)
 *   - `compose`    deterministic HTML/text template
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
} from "./gather";

export { composeBriefing } from "./compose";
export type { ComposedBriefing, ComposeBriefingArgs } from "./compose";

export {
  BRIEFING_WORKFLOW_SLUG,
  briefingWorkflowInputSchema,
} from "./workflow-input";
export type { BriefingWorkflowInput } from "./workflow-input";

export {
  startBriefingWorker,
  stopBriefingWorker,
  closeBriefingQueue,
  getBriefingQueue,
  enqueueBriefingRun,
  type BriefingJobData,
} from "./queue";
export { scheduleRepeatableBriefingJobs } from "./repeatable";
