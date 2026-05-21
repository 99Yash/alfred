import { z } from "zod";

/**
 * Public input schema + slugs for the briefing workflows. Mirrored from
 * the email-triage pattern: callers (cron, smoke script) import from
 * here without reaching into `apps/server`.
 *
 * Two workflows live here today:
 *
 *   - `morning-briefing` — the deterministic v1 (ADR-0025 #2). Inbox-only,
 *     fixed-template renderer. Stays for now while the LLM-composed
 *     daily-briefing is under smoke.
 *   - `daily-briefing` — LLM-composed, two slots ('morning' | 'evening'),
 *     watermarked delta + prior-briefing memory. The replacement; retires
 *     `morning-briefing` once the smoke comparison against Dimension's
 *     samples is satisfactory.
 */

export const BRIEFING_WORKFLOW_SLUG = "morning-briefing";

export const DAILY_BRIEFING_WORKFLOW_SLUG = "daily-briefing";

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

/**
 * Input schema for the LLM-composed daily briefing. Adds `slot` on top
 * of the v1 fields so one workflow definition covers morning + evening.
 *
 * `dryRun` short-circuits the `send` step (no Resend call, no email_sends
 * row) AND marks the briefing_runs row as `status='dry_run'`, which keeps
 * it out of `fetchLatestWatermark`'s view — the next real run still
 * sees the full email window. Use this for prompt iteration.
 */
export const dailyBriefingWorkflowInputSchema = briefingWorkflowInputSchema.extend({
  slot: z.enum(["morning", "evening"]),
  dryRun: z.boolean().default(false),
});

export type DailyBriefingWorkflowInput = z.infer<typeof dailyBriefingWorkflowInputSchema>;
