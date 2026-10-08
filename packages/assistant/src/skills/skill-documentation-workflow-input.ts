import { z } from "zod";

/**
 * Input and slug for `skill-documentation`, phase 2 of Learn (ADR-0017).
 * `learn-skill` enqueues it after a v1 revision commits. One run per skill: a second
 * Learn click is blocked by the dedup index, and the running doc re-reads the latest v1.
 */

export const SKILL_DOCUMENTATION_WORKFLOW_SLUG = "skill-documentation";

export const skillDocumentationInputSchema = z.object({
  skillId: z.string().min(1),
  /** Telemetry only. The workflow re-reads `skills.current_revision_id`. */
  triggeringLearnRunId: z.string().optional(),
});

export type SkillDocumentationInput = z.infer<typeof skillDocumentationInputSchema>;

/** At most one documentation run per skill. */
export function skillDocumentationDedupKey(skillId: string): string {
  return `skill-doc:${skillId}`;
}
