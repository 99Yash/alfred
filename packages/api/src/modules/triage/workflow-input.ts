import { z } from "zod";

/**
 * Public input schema + slug for the email-triage workflow. Lives in the
 * api package (not the workflow file under apps/server) so callers that
 * enqueue runs — ingest path, webhook handler, smoke scripts — don't need
 * to import from `apps/server`.
 */

export const TRIAGE_WORKFLOW_SLUG = "email-triage";

export const triageWorkflowInputSchema = z.object({
  documentId: z.string().min(1),
  /** Optional reason metadata — `ingest`, `webhook`, `manual`, `reply`. */
  reason: z.enum(["ingest", "webhook", "manual", "reply"]).optional(),
  /**
   * Backfill escape hatch: bypass the already-tagged skip guard so a thread
   * still sitting on the message it was last classified from RE-classifies
   * anyway (re-mint todos + re-tag under a new prompt). Never set on the
   * real-time ingest/webhook path — only one-off backfills pass it.
   */
  force: z.boolean().optional(),
});
export type TriageWorkflowInput = z.infer<typeof triageWorkflowInputSchema>;
