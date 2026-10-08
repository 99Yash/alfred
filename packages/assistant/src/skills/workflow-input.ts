import { z } from "zod";

/**
 * Input and slug for `learn-skill`. One run per `skillId` via the dedup index;
 * a repeated click gets 23505, and the handler returns the existing run id.
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

/** At most one Learn run per skill. */
export function learnSkillDedupKey(skillId: string): string {
  return `learn-skill:${skillId}`;
}
