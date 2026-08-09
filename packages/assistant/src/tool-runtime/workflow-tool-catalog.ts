import type {
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  ToolAvailabilityResult,
  ToolName,
  ToolRunContext,
} from "@alfred/contracts";

import { bootPort } from "./boot-port";

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
 * Surface:  workflows.
 * Owns/hides: owns a read-only projection of the tools registry — each tool's
 *   name, integration, credential slice, and one bound availability verdict.
 *   Hides `execute`, `inputSchema`, `staging`, and every other RegisteredTool
 *   internal. `catalog()` returns a fresh snapshot each call.
 * Why the seam: it inverts workflows -> tools, so a workflow readiness, author,
 *   or revision read confirms a tool without an import edge to tools.
 * Wiring: tools/workflow-tool-catalog-source.ts installs; workflows readiness
 *   (runtime-readiness.ts, authoring.ts, revisions.ts) reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface WorkflowToolCatalogSource {
  catalog(): WorkflowToolCatalog;
}

const workflowToolCatalogSourcePort = bootPort<WorkflowToolCatalogSource>(
  "workflow tool-catalog source",
);

/** Runtime composition registers the tools-backed source before any read. */
export function registerWorkflowToolCatalogSource(source: WorkflowToolCatalogSource): () => void {
  return workflowToolCatalogSourcePort.install(source);
}

function requireWorkflowToolCatalogSource(): WorkflowToolCatalogSource {
  return workflowToolCatalogSourcePort.read();
}

/** A fresh projection of the currently registered tools, for a workflow read. */
export function workflowToolCatalog(): WorkflowToolCatalog {
  return requireWorkflowToolCatalogSource().catalog();
}
