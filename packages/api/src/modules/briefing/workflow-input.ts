import { z } from "zod";

/**
 * Public input schema + slug for the morning-briefing workflow. Mirrored
 * from the email-triage pattern: callers (cron, smoke script) import
 * from here without reaching into `apps/server`.
 */

export const BRIEFING_WORKFLOW_SLUG = "morning-briefing";

export const briefingWorkflowInputSchema = z.object({
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

export type BriefingWorkflowInput = z.infer<typeof briefingWorkflowInputSchema>;
