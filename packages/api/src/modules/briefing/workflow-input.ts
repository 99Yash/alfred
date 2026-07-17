import { briefingSlotSchema } from "@alfred/contracts";
import { z } from "zod";

/** Canonical live briefing workflow: both morning and evening slots. */
export const DAILY_BRIEFING_WORKFLOW_SLUG = "daily-briefing";

const briefingWorkflowInputBaseSchema = z.object({
  /**
   * `morning` can suppress on quiet cron runs; `evening` always sends.
   * Defaults to morning for existing callers that predate ADR-0048.
   */
  slot: briefingSlotSchema.default("morning"),
  /**
   * The user's local date this briefing is *for* (YYYY-MM-DD). Used as
   * the day-segment of the idempotency key; a duplicate enqueue with
   * the same date short-circuits at the `email_sends` unique index.
   *
   * Optional: when omitted, the workflow computes it from the user's
   * preferred timezone at run time. Pass it explicitly from the cron
   * tick so the date the cron evaluated lines up with the date the
   * workflow uses.
   */
  briefingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .optional(),
  /**
   * `cron` — fired by the hourly tick.
   * `manual` — invoked by smoke script or future settings-page button.
   * `forced` — bypasses the "send only at delivery_hour" check.
   */
  reason: z.enum(["cron", "manual", "forced"]).default("cron"),
});

/**
 * Input schema for the live daily briefing. One workflow definition covers
 * the morning and evening slots.
 *
 * `dryRun` short-circuits the `send` step (no Resend call, no email_sends
 * row) and leaves the `briefings` row at `status='composed'` — a
 * non-terminal state that `fetchLatestWatermark` ignores, so the next
 * real run still sees the full email window. Use this for prompt iteration.
 */
export const dailyBriefingWorkflowInputSchema = briefingWorkflowInputBaseSchema.extend({
  slot: briefingSlotSchema,
  dryRun: z.boolean().default(false),
});

export type DailyBriefingWorkflowInput = z.infer<typeof dailyBriefingWorkflowInputSchema>;

/**
 * Compatibility-only identity and input parser for persisted nonterminal runs
 * created before the daily-briefing cutover. New code must not enqueue it.
 */
export const LEGACY_MORNING_BRIEFING_WORKFLOW_SLUG = "morning-briefing";
export const legacyMorningBriefingWorkflowInputSchema = briefingWorkflowInputBaseSchema;
export type LegacyMorningBriefingWorkflowInput = z.infer<
  typeof legacyMorningBriefingWorkflowInputSchema
>;
