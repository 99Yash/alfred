/**
 * Skill authoring + execution primitives (ADR-0017).
 *
 * Module shape mirrors `cold-start/`:
 *   - `workflow-input`  slug + zod schema for the `learn-skill` workflow
 *   - `mentions`        `@`-mention parser + registry-aware resolver
 *   - `context`         pure read of user identity + active facts +
 *                       connected integrations + existing skill slugs
 *   - `distill`         cheap-tier extractor (one structured-output call
 *                       producing body + name + fact proposals)
 *   - `revisions`       transactional commit of skill_revisions +
 *                       skills.current_revision_id + skill_runs lifecycle
 *
 * The workflow itself lives in apps/server/src/builtins/workflows/
 * learn-skill.ts and only orchestrates these helpers. The async deep-
 * documentation phase (`skill-documentation`) lands alongside in 12c.
 */

export {
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  learnSkillWorkflowInputSchema,
} from "./workflow-input";
export type { LearnSkillWorkflowInput } from "./workflow-input";

export { MENTION_KINDS, parseMentions, parsedMentionSchema, resolveMentions } from "./mentions";
export type { MentionKind, MentionRegistry, ParsedMention } from "./mentions";

export { collectSkillLearnContext } from "./context";
export type { SkillLearnContext } from "./context";

export { distillResultSchema, distillSkill, skillProposalSchema } from "./distill";
export type { DistillResult, DistillSkillArgs, DistillSkillResult, SkillProposal } from "./distill";

export { commitSkillRevision, finalizeSkillRun, recordSkillRun } from "./revisions";
export type {
  CommitRevisionArgs,
  CommitRevisionResult,
  FinalizeSkillRunArgs,
  RecordSkillRunArgs,
} from "./revisions";

export { slugifyForUser } from "./slug";
export { skillsRoutes } from "./routes";
