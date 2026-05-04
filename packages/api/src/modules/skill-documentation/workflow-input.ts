import { z } from "zod";

/**
 * Public input schema + slug for the `skill-documentation` workflow —
 * phase 2 of dimension's two-phase Learn (ADR-0017).
 *
 * This workflow is enqueued automatically by `learn-skill`'s persist
 * step once a v1 (`distilled`) revision commits. It runs asynchronously
 * (typically a few minutes), reads from the user's connected sources via
 * hybrid search + memory recall, composes a richer body, writes a v2
 * (`documented`) revision, and sends the user a "Skill documented:
 * <name>" email. The email fires unconditionally on success — there is
 * no per-doc HIL gate (per dimension's behavior; the only HIL in the
 * Learn pipeline lives on user_facts proposals).
 *
 * Concurrency: per-skill dedup. If a second Learn click lands while the
 * first doc run is still executing, the partial unique index on
 * `agent_runs.(user_id, workflow_slug, dedup_key)` blocks the second
 * insert. The earlier doc run continues and re-reads `current_revision_id`
 * in `gather-context`, so it documents whatever the latest v1 is at that
 * moment — most-recent-wins without needing a cancellation hop.
 */

export const SKILL_DOCUMENTATION_WORKFLOW_SLUG = "skill-documentation";

export const skillDocumentationInputSchema = z.object({
  skillId: z.string().min(1),
  /**
   * Pointer to the `learn-skill` agent run that produced the v1 revision
   * triggering this doc run. Used for telemetry only — the workflow
   * always re-reads `skills.current_revision_id` rather than trusting
   * the input, so a stale `triggeringLearnRunId` doesn't cause stale
   * documentation.
   */
  triggeringLearnRunId: z.string().optional(),
});

export type SkillDocumentationInput = z.infer<typeof skillDocumentationInputSchema>;

/** Per-skill singleton key — at most one in-flight documentation run per skill. */
export function skillDocumentationDedupKey(skillId: string): string {
  return `skill-doc:${skillId}`;
}
