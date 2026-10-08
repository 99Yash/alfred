import {
  buildMemoryExtractionWorkflow,
  coldStartResearchWorkflow,
} from "@alfred/assistant/knowledge";
import { chatMemoryCaptureWorkflow, chatTurnWorkflow } from "@alfred/assistant/chat";
import { dailyBriefingWorkflow, morningBriefingWorkflow } from "@alfred/assistant/briefings";
import { emailTriageWorkflow, gmailSenderAdapter } from "@alfred/assistant/triage";
import { replyDraftingWorkflow } from "@alfred/assistant/reply-drafting";
import { learnSkillWorkflow, skillDocumentationWorkflow } from "@alfred/assistant/skills";
import { userAuthoredBriefWorkflow } from "@alfred/assistant/execution/workflows/user-authored-brief";
import { registerRecipe } from "@alfred/assistant/execution";
import { echoWithApprovalWorkflow } from "../scripts/smokes/echo-with-approval";

/** Register every built-in workflow. The registry is in memory, so run before workers start. */
export function registerBuiltinWorkflows(): void {
  registerRecipe(echoWithApprovalWorkflow);
  // Injected so memory never imports triage's parsers (ADR-0089).
  registerRecipe(buildMemoryExtractionWorkflow(gmailSenderAdapter));
  registerRecipe(chatMemoryCaptureWorkflow);
  registerRecipe(emailTriageWorkflow);
  // Started by the post-triage gate, never by the event bus (ADR-0098).
  registerRecipe(replyDraftingWorkflow);
  // Kept only so persisted unfinished checkpoints can resume. No new runs.
  registerRecipe(morningBriefingWorkflow);
  registerRecipe(dailyBriefingWorkflow);
  registerRecipe(coldStartResearchWorkflow);
  registerRecipe(learnSkillWorkflow);
  registerRecipe(skillDocumentationWorkflow);
  registerRecipe(chatTurnWorkflow);
  // Sub-agents run on this slug, so the registry must resolve it, not only the DB path.
  registerRecipe(userAuthoredBriefWorkflow);
}
