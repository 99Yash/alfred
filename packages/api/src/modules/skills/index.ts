// Transitional barrel: re-exports domain logic from @alfred/assistant/skills.
// Transport left: the skills route now lives in @alfred/http and never used
// this barrel. What is left is the skills half of the @alfred/api/backend
// service surface, for server-side callers that have not moved to
// @alfred/assistant/skills yet. Do not enumerate those callers here — some of
// them live only in test files, which api's tsconfig.test.json excludes, so an
// enumeration written in this comment is invisible to every static gate and
// goes stale without anything saying so.
// @alfred/api/backend surface is unchanged (byte-identical re-exports).
// Combines the public surface of the original skills + skill-revisions + skill-documentation modules.

export {
  LEARN_SKILL_WORKFLOW_SLUG,
  learnSkillDedupKey,
  learnSkillWorkflowInputSchema,
  type LearnSkillWorkflowInput,
} from "@alfred/assistant/skills";

export {
  MENTION_KINDS,
  parseMentions,
  parsedMentionSchema,
  resolveMentions,
  type MentionKind,
  type MentionRegistry,
  type ParsedMention,
} from "@alfred/assistant/skills";

export { collectSkillLearnContext, type SkillLearnContext } from "@alfred/assistant/skills";

export {
  distillResultSchema,
  distillSkill,
  skillProposalSchema,
  type DistillResult,
  type DistillSkillArgs,
  type DistillSkillResult,
  type SkillProposal,
} from "@alfred/assistant/skills";

export { learnSkillWorkflow } from "@alfred/assistant/skills";

export { slugifyForUser } from "@alfred/assistant/skills";

// Skill-revisions exports (now part of skills)
export {
  commitSkillRevision,
  finalizeSkillRun,
  recordSkillRun,
  type CommitRevisionArgs,
  type CommitRevisionResult,
  type FinalizeSkillRunArgs,
  type RecordSkillRunArgs,
} from "@alfred/assistant/skills";

// Skill-documentation exports (now part of skills)
export {
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  skillDocumentationDedupKey,
  skillDocumentationInputSchema,
  type SkillDocumentationInput,
} from "@alfred/assistant/skills";

export {
  collectSkillDocumentationContext,
  type SkillDocumentationContext,
} from "@alfred/assistant/skills";

export {
  composeSkillDocumentation,
  type ComposeArgs,
  type ComposedDocumentation,
} from "@alfred/assistant/skills";

export {
  composeSkillDocumentationEmail,
  type SkillDocumentationEmailArgs,
} from "@alfred/assistant/skills";

export { skillDocumentationWorkflow } from "@alfred/assistant/skills";
