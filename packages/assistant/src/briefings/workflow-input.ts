import { briefingSlotSchema } from "@alfred/contracts";
import { z } from "zod";
import { isLocalDateKey } from "@alfred/assistant/time";

/** The live briefing workflow, for both slots. */
export const DAILY_BRIEFING_WORKFLOW_SLUG = "daily-briefing";

const briefingWorkflowInputBaseSchema = z.object({
  /** `morning` may suppress on quiet cron runs; `evening` always sends. */
  slot: briefingSlotSchema.default("morning"),
  /**
   * The user's local date this briefing is for; part of the idempotency key.
   * Omit it and the workflow computes it. The cron tick passes it so both agree.
   */
  briefingDate: z
    .string()
    // Not a regex: "2026-02-30" passes a regex and `Date.UTC` silently rolls it over.
    .refine(isLocalDateKey, "expected an existing calendar day, YYYY-MM-DD")
    .optional(),
  /** `cron` from the tick; `manual` from the smoke script or button; `forced` skips the delivery-hour check. */
  reason: z.enum(["cron", "manual", "forced"]).default("cron"),
});

/**
 * `dryRun` skips send and leaves the row `composed`. `fetchLatestWatermark` ignores that
 * state, so the next real run still sees the full window. Use it for prompt work.
 */
export const dailyBriefingWorkflowInputSchema = briefingWorkflowInputBaseSchema.extend({
  slot: briefingSlotSchema,
  dryRun: z.boolean().default(false),
});

export type DailyBriefingWorkflowInput = z.infer<typeof dailyBriefingWorkflowInputSchema>;

/** Only for old in-flight runs from before the daily-briefing cutover. Do not enqueue. */
export const LEGACY_MORNING_BRIEFING_WORKFLOW_SLUG = "morning-briefing";

export const legacyMorningBriefingWorkflowInputSchema = briefingWorkflowInputBaseSchema;

export type LegacyMorningBriefingWorkflowInput = z.infer<
  typeof legacyMorningBriefingWorkflowInputSchema
>;
