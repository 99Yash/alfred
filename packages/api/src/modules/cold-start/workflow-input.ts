import { z } from "zod";

/**
 * Public input schema + slug for the cold-start research workflow.
 * Mirrored from the briefing pattern so callers (signup trigger, smoke
 * script) can reach in without touching `apps/server`.
 */

export const COLD_START_WORKFLOW_SLUG = "cold-start-research";

export const coldStartWorkflowInputSchema = z.object({
  /**
   * Bypass the "already ran for this user" dedup check. Used by the
   * smoke script to force a fresh research pass; the signup trigger
   * never sets this.
   */
  force: z.boolean().default(false),
  /**
   * `signup` — fired by the OAuth-callback trigger.
   * `manual` — fired by the smoke script or a future settings re-run button.
   */
  reason: z.enum(["signup", "manual"]).default("signup"),
});

export type ColdStartWorkflowInput = z.infer<typeof coldStartWorkflowInputSchema>;
