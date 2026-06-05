import { chatTurnWorkflow, registerWorkflow } from "@alfred/api";
import { coldStartResearchWorkflow } from "./workflows/cold-start-research";
import { dailyBriefingWorkflow } from "./workflows/daily-briefing";
import { echoWithApprovalWorkflow } from "./workflows/echo-with-approval";
import { emailTriageWorkflow } from "./workflows/email-triage";
import { learnSkillWorkflow } from "./workflows/learn-skill";
import { memoryExtractionWorkflow } from "./workflows/memory-extraction";
import { morningBriefingWorkflow } from "./workflows/morning-briefing";
import { skillDocumentationWorkflow } from "./workflows/skill-documentation";

/**
 * Boot-time registration of every built-in workflow. Add new workflows
 * here as they ship; the registry is in-memory so registration must run
 * before the worker starts pulling jobs.
 */
export function registerBuiltinWorkflows(): void {
  registerWorkflow(echoWithApprovalWorkflow);
  registerWorkflow(memoryExtractionWorkflow);
  registerWorkflow(emailTriageWorkflow);
  registerWorkflow(morningBriefingWorkflow);
  registerWorkflow(dailyBriefingWorkflow);
  registerWorkflow(coldStartResearchWorkflow);
  registerWorkflow(learnSkillWorkflow);
  registerWorkflow(skillDocumentationWorkflow);
  registerWorkflow(chatTurnWorkflow);
}
