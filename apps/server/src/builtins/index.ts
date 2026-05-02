import { registerWorkflow } from "@alfred/api";
import { echoWithApprovalWorkflow } from "./workflows/echo-with-approval";
import { emailTriageWorkflow } from "./workflows/email-triage";
import { memoryExtractionWorkflow } from "./workflows/memory-extraction";

/**
 * Boot-time registration of every built-in workflow. Add new workflows
 * here as they ship; the registry is in-memory so registration must run
 * before the worker starts pulling jobs.
 */
export function registerBuiltinWorkflows(): void {
  registerWorkflow(echoWithApprovalWorkflow);
  registerWorkflow(memoryExtractionWorkflow);
  registerWorkflow(emailTriageWorkflow);
}
