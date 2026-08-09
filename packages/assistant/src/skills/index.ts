/**
 * Skill authoring, execution, revision persistence, and documentation (ADR-0017).
 *
 * Consolidated module combining the original three api modules:
 *   - skills: learn-skill workflow (phase 1, cheap-tier extraction)
 *   - skill-revisions: run + revision persistence (shared by phases 1 & 2)
 *   - skill-documentation: documentation workflow (phase 2, documented v2)
 */

// Skill authoring (phase 1)
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

export { learnSkillWorkflow } from "./learn-skill";

export { slugifyForUser } from "./slug";

// Skill revision persistence (shared seam)
export { commitSkillRevision, finalizeSkillRun, recordSkillRun } from "./revisions";
export type {
  CommitRevisionArgs,
  CommitRevisionResult,
  FinalizeSkillRunArgs,
  RecordSkillRunArgs,
} from "./revisions";

// Skill documentation (phase 2)
export {
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  skillDocumentationDedupKey,
  skillDocumentationInputSchema,
} from "./skill-documentation-workflow-input";
export type { SkillDocumentationInput } from "./skill-documentation-workflow-input";

export { collectSkillDocumentationContext } from "./skill-documentation-context";
export type { SkillDocumentationContext } from "./skill-documentation-context";

export { composeSkillDocumentation } from "./compose";
export type { ComposeArgs, ComposedDocumentation } from "./compose";

export { composeSkillDocumentationEmail } from "./email";
export type { SkillDocumentationEmailArgs } from "./email";

export { skillDocumentationWorkflow } from "./skill-documentation";
