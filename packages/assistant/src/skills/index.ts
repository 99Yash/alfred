/** Skills: Learn phase 1, revision persistence, and documentation phase 2 (ADR-0017). */

// Phase 1
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

// Revisions (shared)
export { commitSkillRevision, finalizeSkillRun, recordSkillRun } from "./revisions";

export type {
  CommitRevisionArgs,
  CommitRevisionResult,
  FinalizeSkillRunArgs,
  RecordSkillRunArgs,
} from "./revisions";

// Phase 2
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
