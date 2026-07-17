/**
 * Cold-start research at signup (ADR-0011 + ADR-0022, v2 amendment).
 *
 * v2 replaces the single stranded Perplexity Sonar Deep Research call with the
 * agent harness, run bounded inside a deterministic onboarding workflow:
 *   - `signals`         pure read of identity evidence
 *   - `seed`            boss identity resolution → an anchor (web_search)
 *   - `aspects`         bounded parallel sub-agents, one per facet (web_search)
 *   - `synthesis`       boss folds findings → ~300w telegraphic summary
 *   - `extract`         cheap-tier prose → structured fact proposals
 *   - `workflow-input`  slug + zod schema for callers that enqueue
 *
 * The `synthesis` output keeps the old `ResearchResult` shape, so the
 * `extract` → persist tail (ADR-0019's two-stage extract) is unchanged.
 *
 * The workflow itself lives in apps/server/builtins/workflows/
 * cold-start-research.ts and only orchestrates these helpers.
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
