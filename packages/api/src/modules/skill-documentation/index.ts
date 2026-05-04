/**
 * Skill documentation — phase 2 of dimension's two-phase Learn (ADR-0017).
 *
 * Module shape mirrors `cold-start/` and `skills/`:
 *   - `workflow-input`  slug + zod schema + per-skill dedup key
 *   - `context`         hybrid search (semanticSearch + recallMemory) +
 *                       active-fact pull, keyed on the v1 body
 *   - `compose`         boss-tier `meteredGenerateText` producing the v2
 *                       body that integrates retrieved evidence
 *   - `email`           deterministic HTML+text renderer for the
 *                       "Skill documented: <name>" notification
 *
 * The workflow itself lives in apps/server/src/builtins/workflows/
 * skill-documentation.ts and only orchestrates these helpers.
 */

export {
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  skillDocumentationDedupKey,
  skillDocumentationInputSchema,
} from "./workflow-input";
export type { SkillDocumentationInput } from "./workflow-input";

export { collectSkillDocumentationContext } from "./context";
export type { SkillDocumentationContext } from "./context";

export { composeSkillDocumentation } from "./compose";
export type { ComposeArgs, ComposedDocumentation } from "./compose";

export { composeSkillDocumentationEmail } from "./email";
export type { ComposedDocumentationEmail, SkillDocumentationEmailArgs } from "./email";
