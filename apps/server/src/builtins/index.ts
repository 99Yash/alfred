import {
  chatMemoryCaptureWorkflow,
  chatTurnWorkflow,
  dailyBriefingWorkflow,
  emailTriageWorkflow,
  learnSkillWorkflow,
  memoryExtractionWorkflow,
  morningBriefingWorkflow,
  skillDocumentationWorkflow,
  userAuthoredBriefWorkflow,
} from "@alfred/api/backend";
import { registerRecipe } from "@alfred/api/runtime";
import { echoWithApprovalWorkflow } from "../scripts/smokes/echo-with-approval";
// Transitional recipe still living in the composition root. `cold-start-research`
// cannot move into `cold-start` until item 07 breaks the `memory -> cold-start`
// edge. It stays registered here with byte-identical behavior (plan Design
// rule 10, a named transitional door).
import { coldStartResearchWorkflow } from "./workflows/cold-start-research";

/**
 * Boot-time registration of every built-in workflow. Add new workflows
 * here as they ship; the registry is in-memory so registration must run
 * before the worker starts pulling jobs.
 */
export function registerBuiltinWorkflows(): void {
  registerRecipe(echoWithApprovalWorkflow);
  registerRecipe(memoryExtractionWorkflow);
  registerRecipe(chatMemoryCaptureWorkflow);
  registerRecipe(emailTriageWorkflow);
  // Resume compatibility only: hidden from catalogs/seeding and unavailable
  // for new runs, but required by persisted nonterminal agent checkpoints.
  registerRecipe(morningBriefingWorkflow);
  registerRecipe(dailyBriefingWorkflow);
  registerRecipe(coldStartResearchWorkflow);
  registerRecipe(learnSkillWorkflow);
  registerRecipe(skillDocumentationWorkflow);
  registerRecipe(chatTurnWorkflow);
  // The sub-agent / focused-brief executor. Sub-agents spawned from any parent
  // (including the thread-coupled chat-turn) run on this slug, so it must be
  // resolvable by the registry — not only via the authored-workflow DB path.
  registerRecipe(userAuthoredBriefWorkflow);
}
