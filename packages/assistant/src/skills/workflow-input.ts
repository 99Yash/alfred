import { z } from "zod";

/**
 * Input and slug for `learn-skill`. One live run per `skillId` via the concurrency index;
 * a click while one runs gets 23505, and the handler answers "in flight". A finished run frees it.
 */

export const LEARN_SKILL_WORKFLOW_SLUG = "learn-skill";

export const learnSkillWorkflowInputSchema = z.object({
  /** Created when the user clicks "New skill". */
  skillId: z.string().min(1),
  /** What the user typed. */
  prompt: z.string().min(1).max(8_000),
  /** `regen` means the user clicked Regenerate. Telemetry only. */
  reason: z.enum(["manual", "regen"]).default("manual"),
});

export type LearnSkillWorkflowInput = z.infer<typeof learnSkillWorkflowInputSchema>;

/** At most one live Learn run per skill. A completed run frees it, so Regenerate works. */
export function learnSkillConcurrencyKey(skillId: string): string {
  return `learn-skill:${skillId}`;
}
