import {
  buildMemoryExtractionWorkflow,
  coldStartResearchWorkflow,
} from "@alfred/assistant/knowledge";
import { chatMemoryCaptureWorkflow, chatTurnWorkflow } from "@alfred/assistant/chat";
import { dailyBriefingWorkflow, morningBriefingWorkflow } from "@alfred/assistant/briefings";
import { emailTriageWorkflow, gmailSenderAdapter } from "@alfred/assistant/triage";
import { learnSkillWorkflow, skillDocumentationWorkflow } from "@alfred/assistant/skills";
import { userAuthoredBriefWorkflow } from "@alfred/assistant/execution/workflows/user-authored-brief";
import { registerRecipe } from "@alfred/assistant/execution";
import { echoWithApprovalWorkflow } from "../scripts/smokes/echo-with-approval";

/**
 * Boot-time registration of every built-in workflow. Add new workflows
 * here as they ship; the registry is in-memory so registration must run
 * before the worker starts pulling jobs.
 */
export function registerBuiltinWorkflows(): void {
  registerRecipe(echoWithApprovalWorkflow);
  // Inject the triage-owned Gmail sender adapter (ADR-0089) so memory never
  // imports triage's From/SENT parsers.
  registerRecipe(buildMemoryExtractionWorkflow(gmailSenderAdapter));
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
