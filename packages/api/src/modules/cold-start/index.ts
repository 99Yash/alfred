/**
 * Cold-start research at signup (ADR-0011 + ADR-0022).
 *
 * Module shape mirrors briefing/triage:
 *   - `signals`         pure read of identity evidence
 *   - `research`        Sonar Deep Research call (web_search-metered)
 *   - `extract`         cheap-tier prose → structured fact proposals
 *   - `dedup`           "has this user already had a research run?"
 *   - `workflow-input`  slug + zod schema for callers that enqueue
 *
 * The workflow itself lives in apps/server/builtins/workflows/
 * cold-start-research.ts and only orchestrates these helpers.
 */

export { collectColdStartSignals } from "./signals";
export type { ColdStartSignals } from "./signals";

export { researchUser } from "./research";
export type { ResearchResult } from "./research";

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
