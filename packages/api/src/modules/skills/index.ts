// Transitional barrel: re-exports domain logic from @alfred/assistant/skills.
// Routes stay here and import from this barrel.
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

export { skillsRoutes } from "./routes";
