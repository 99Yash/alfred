import { chatTurnWorkflow, userAuthoredBriefWorkflow } from "@alfred/api/backend";
import { registerWorkflow } from "@alfred/api/runtime";
import { chatMemoryCaptureWorkflow } from "./workflows/chat-memory-capture";
import { coldStartResearchWorkflow } from "./workflows/cold-start-research";
import { dailyBriefingWorkflow } from "./workflows/daily-briefing";
import { echoWithApprovalWorkflow } from "./workflows/echo-with-approval";
import { emailTriageWorkflow } from "./workflows/email-triage";
import { learnSkillWorkflow } from "./workflows/learn-skill";
import { morningBriefingWorkflow } from "./workflows/legacy/morning-briefing";
import { memoryExtractionWorkflow } from "./workflows/memory-extraction";
import { skillDocumentationWorkflow } from "./workflows/skill-documentation";

/**
 * Boot-time registration of every built-in workflow. Add new workflows
 * here as they ship; the registry is in-memory so registration must run
 * before the worker starts pulling jobs.
 */
export function registerBuiltinWorkflows(): void {
  registerWorkflow(echoWithApprovalWorkflow);
  registerWorkflow(memoryExtractionWorkflow);
  registerWorkflow(chatMemoryCaptureWorkflow);
  registerWorkflow(emailTriageWorkflow);
  // Resume compatibility only: hidden from catalogs/seeding and unavailable
  // for new runs, but required by persisted nonterminal agent checkpoints.
  registerWorkflow(morningBriefingWorkflow);
  registerWorkflow(dailyBriefingWorkflow);
  registerWorkflow(coldStartResearchWorkflow);
  registerWorkflow(learnSkillWorkflow);
  registerWorkflow(skillDocumentationWorkflow);
  registerWorkflow(chatTurnWorkflow);
  // The sub-agent / focused-brief executor. Sub-agents spawned from any parent
  // (including the thread-coupled chat-turn) run on this slug, so it must be
  // resolvable by the registry — not only via the authored-workflow DB path.
  registerWorkflow(userAuthoredBriefWorkflow);
}
