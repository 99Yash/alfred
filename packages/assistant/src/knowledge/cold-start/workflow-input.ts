import { z } from "zod";

/**
 * Slug and input schema for the cold-start workflow. Once per user: the dedup index
 * rejects a second run. There is no `force` input, because any user could then spam
 * expensive research through `/api/agent/runs`.
 */

export const COLD_START_WORKFLOW_SLUG = "cold-start-research";

/** A constant: one cold-start run per user. */
export const COLD_START_DEDUP_KEY = "cold-start";

export const coldStartWorkflowInputSchema = z.object({
  /** `signup` from the OAuth callback; `manual` from a script. */
  reason: z.enum(["signup", "manual"]).default("signup"),
});

export type ColdStartWorkflowInput = z.infer<typeof coldStartWorkflowInputSchema>;
