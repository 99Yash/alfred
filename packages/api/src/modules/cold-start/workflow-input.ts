import { z } from "zod";

/**
 * Public input schema + slug for the cold-start research workflow.
 * Mirrored from the briefing pattern so callers (signup trigger, smoke
 * script) can reach in without touching `apps/server`.
 *
 * Lifetime-once-per-user semantics are enforced at the DB level via the
 * partial unique index on `agent_runs.(user_id, workflow_slug, dedup_key)`
 * — the workflow declares `dedupKey: () => COLD_START_DEDUP_KEY` and a
 * second `createRun` for the same user fails with `23505`. There is no
 * input-level `force` toggle: making bypass caller-controlled would let
 * any authenticated user spam expensive Sonar Deep Research calls via
 * the generic `/api/agent/runs` endpoint. The smoke script bypasses by
 * cancelling the prior row first instead.
 */

export const COLD_START_WORKFLOW_SLUG = "cold-start-research";

/**
 * Singleton key for the cold-start workflow — there is at most one
 * logical "cold-start research" per user, so the key is a constant
 * rather than derived from input.
 */
export const COLD_START_DEDUP_KEY = "cold-start";

export const coldStartWorkflowInputSchema = z.object({
  /**
   * `signup` — fired by the OAuth-callback trigger.
   * `manual` — fired by the smoke script or a future settings re-run button.
   */
  reason: z.enum(["signup", "manual"]).default("signup"),
});

export type ColdStartWorkflowInput = z.infer<typeof coldStartWorkflowInputSchema>;
