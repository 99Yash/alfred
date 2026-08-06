/**
 * Skill run + revision persistence (ADR-0017, ADR-0089).
 *
 * A leaf seam under both skill-authoring phases: `skills` (sync phase-1
 * `learn-skill`) commits the `distilled` v1 and records/finalizes the run;
 * `skill-documentation` (async phase-2) commits the `documented` v2. Both
 * import DOWN into this module, so neither product module imports the other
 * for persistence and the `skills ↔ skill-documentation` graph stays acyclic.
 *
 *   - `revisions`  transactional commit of skill_revisions +
 *                  skills.current_revision_id + skill_runs lifecycle
 */

export { commitSkillRevision, finalizeSkillRun, recordSkillRun } from "./revisions";
export type {
  CommitRevisionArgs,
  CommitRevisionResult,
  FinalizeSkillRunArgs,
  RecordSkillRunArgs,
} from "./revisions";
