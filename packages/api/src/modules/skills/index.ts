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
 *   - `learn-skill`     the sync phase-1 recipe that orchestrates the above
 *
 * Run + revision persistence lives one level DOWN in the `skill-revisions`
 * leaf, which both this module and `skill-documentation` (async phase 2)
 * import into — keeping the two authoring phases acyclic.
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

export { learnSkillWorkflow } from "./learn-skill";

export { slugifyForUser } from "./slug";
export { skillsRoutes } from "./routes";
