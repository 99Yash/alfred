import type { ToolName } from "@alfred/contracts";
import {
  registerWorkflowToolCatalogSource,
  type WorkflowToolCatalog,
  type WorkflowToolCatalogSource,
  type WorkflowToolFacts,
} from "./workflow-tool-catalog";
import { evaluateToolAvailability, listRegisteredTools } from "./internal/registry";

/** Projects each registered tool to `WorkflowToolFacts`, so workflows never import the registry (ADR-0089). */
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

export function registerWorkflowToolCatalog(): () => void {
  return registerWorkflowToolCatalogSource(workflowToolCatalogSource);
}
