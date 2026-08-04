import type {
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  ToolAvailabilityResult,
  ToolName,
  ToolRunContext,
} from "@alfred/contracts";

/**
 * The exact tool facts a workflow readiness, authoring, or revision read needs,
 * and nothing more. It is a projection of the tools registry: `workflows` sees
 * only `name`, `integration`, the credential slice, and one bound availability
 * verdict — never `execute`, `inputSchema`, `staging`, or any other
 * `RegisteredTool` internal. The verdict travels with the entry so the readiness
 * functions stay pure and catalog-injected (ADR-0089: the runtime composes
 * tools; workflows do not read the tools module).
 */
export interface WorkflowToolFacts {
  name: ToolName;
  integration: IntegrationSlug;
  availability?: { credential?: { provider: string; anyOfScopes: readonly string[] } } | undefined;
  /**
   * The same verdict `evaluateToolAvailability(availability, tool, allowed,
   * context)` returns today, bound to this exact tool by the source.
   */
  evaluateAvailability(input: {
    availability: IntegrationAvailabilitySnapshot;
    allowed: ReadonlySet<string>;
    context: ToolRunContext;
  }): ToolAvailabilityResult;
}

/** One immutable snapshot of the tool facts a workflow decision reads. */
export type WorkflowToolCatalog = ReadonlyMap<ToolName, WorkflowToolFacts>;

/**
 * A provided read the tools module installs at boot. `catalog()` returns a fresh
 * snapshot each call, mirroring the live registry the way `createToolCatalog(
 * listRegisteredTools())` did before this seam existed.
 */
export interface WorkflowToolCatalogSource {
  catalog(): WorkflowToolCatalog;
}

let workflowToolCatalogSource: WorkflowToolCatalogSource | undefined;

/** Runtime composition registers the tools-backed source before any read. */
export function registerWorkflowToolCatalogSource(source: WorkflowToolCatalogSource): () => void {
  if (workflowToolCatalogSource) {
    throw new Error("A workflow tool-catalog source is already registered");
  }
  workflowToolCatalogSource = source;
  return () => {
    workflowToolCatalogSource = undefined;
  };
}

function requireWorkflowToolCatalogSource(): WorkflowToolCatalogSource {
  if (!workflowToolCatalogSource) {
    throw new Error("No workflow tool-catalog source is registered");
  }
  return workflowToolCatalogSource;
}

/** A fresh projection of the currently registered tools, for a workflow read. */
export function workflowToolCatalog(): WorkflowToolCatalog {
  return requireWorkflowToolCatalogSource().catalog();
}
