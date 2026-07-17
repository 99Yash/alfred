import { z } from "zod";

/**
 * Public input schema + slug for the `learn-skill` workflow.
 *
 * Mirrors the cold-start pattern: callers (HTTP handler, smoke script,
 * future re-Learn button) reach in here without touching `apps/server`.
 *
 * Concurrency: a Learn run is dedup'd per `skillId` via the partial
 * unique index on `agent_runs.(user_id, workflow_slug, dedup_key)`.
 * Click-spamming Learn while a prior run is still executing returns
 * `23505` to the caller; the request handler catches that and returns
 * the existing run id instead of erroring (handled at 12d).
 */

export const LEARN_SKILL_WORKFLOW_SLUG = "learn-skill";

export const learnSkillWorkflowInputSchema = z.object({
  /** Pre-existing skill row this Learn run feeds. The row is created when the user clicks "New skill". */
  skillId: z.string().min(1),
  /** The user's raw prompt — what they typed into the textarea. */
  prompt: z.string().min(1).max(8_000),
  /**
   * `manual`  — user clicked Learn (default).
   * `regen`   — user clicked Regenerate after seeing a prior distill.
   *             Same workflow run shape; tagged for telemetry only.
   */
  reason: z.enum(["manual", "regen"]).default("manual"),
});

export type LearnSkillWorkflowInput = z.infer<typeof learnSkillWorkflowInputSchema>;

/** Per-skill singleton key — at most one in-flight Learn per skill. */
export function learnSkillDedupKey(skillId: string): string {
  return `learn-skill:${skillId}`;
}
