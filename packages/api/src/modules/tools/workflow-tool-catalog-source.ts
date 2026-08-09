import type { ToolName } from "@alfred/contracts";
import {
  registerWorkflowToolCatalogSource,
  type WorkflowToolCatalog,
  type WorkflowToolCatalogSource,
  type WorkflowToolFacts,
} from "@alfred/assistant/tool-runtime";
import { evaluateToolAvailability, listRegisteredTools } from "./registry";

/**
 * The tools-owned source behind the `workflowToolCatalog()` read. It projects
 * every registered tool to the narrow `WorkflowToolFacts` a workflow readiness,
 * authoring, or revision decision needs, and binds each entry's availability
 * verdict to the exact registered tool. `workflows` reads this projection
 * through the `tool-runtime` seam and never imports the tools registry
 * (ADR-0089).
 */
const workflowToolCatalogSource: WorkflowToolCatalogSource = {
  catalog(): WorkflowToolCatalog {
    const entries = new Map<ToolName, WorkflowToolFacts>();
    for (const tool of listRegisteredTools()) {
      entries.set(tool.name, {
        name: tool.name,
        integration: tool.integration,
        availability: tool.availability,
        evaluateAvailability: (input) =>
          evaluateToolAvailability(input.availability, tool, input.allowed, input.context),
      });
    }
    return entries;
  },
};

/** Install the tools-backed workflow catalog source behind the tool-runtime seam. */
export function registerWorkflowToolCatalog(): () => void {
  return registerWorkflowToolCatalogSource(workflowToolCatalogSource);
}
