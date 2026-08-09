// Transitional barrel: skill documentation (async phase 2) moved to @alfred/assistant/skills
// during 6B. Re-export for backward compatibility with @alfred/api/backend.
export {
  SKILL_DOCUMENTATION_WORKFLOW_SLUG,
  skillDocumentationDedupKey,
  skillDocumentationInputSchema,
  collectSkillDocumentationContext,
  composeSkillDocumentation,
  composeSkillDocumentationEmail,
  skillDocumentationWorkflow,
  type SkillDocumentationInput,
  type SkillDocumentationContext,
  type ComposeArgs,
  type ComposedDocumentation,
  type SkillDocumentationEmailArgs,
} from "@alfred/assistant/skills";
