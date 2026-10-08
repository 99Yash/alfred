/**
 * Cold-start research at signup (ADR-0011, ADR-0022). The workflow lives in
 * `cold-start-research.ts`; the composition root registers it through this barrel.
 */

export { collectColdStartSignals } from "./signals";

export type { ColdStartSignals } from "./signals";

export { resolveIdentity } from "./seed";

export type { IdentityAnchor } from "./seed";

export { researchAspects, selectAspects } from "./aspects";

export type { AspectFinding, ColdStartAspect } from "./aspects";

export { synthesizeColdStart } from "./synthesis";

export type { ResearchResult } from "./synthesis";

export {
  extractColdStartFacts,
  coldStartProposalSchema,
  extractColdStartResultSchema,
} from "./extract";

export type { ColdStartProposal } from "./extract";

export {
  COLD_START_DEDUP_KEY,
  COLD_START_WORKFLOW_SLUG,
  coldStartWorkflowInputSchema,
} from "./workflow-input";

export type { ColdStartWorkflowInput } from "./workflow-input";

export { coldStartResearchWorkflow } from "./cold-start-research";
