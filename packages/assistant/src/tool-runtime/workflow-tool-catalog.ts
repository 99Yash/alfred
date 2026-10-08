import type {
  IntegrationAvailabilitySnapshot,
  IntegrationSlug,
  ToolAvailabilityResult,
  ToolCredentialRequirement,
  ToolName,
  ToolRunContext,
} from "@alfred/contracts";

import { bootPort } from "./boot-port";

/** The registry facts a workflow read needs, with the availability verdict bound in (ADR-0089). */
export interface WorkflowToolFacts {
  name: ToolName;
  integration: IntegrationSlug;
  availability?: { credential?: ToolCredentialRequirement } | undefined;
  /** `evaluateToolAvailability` bound to this tool. */
  evaluateAvailability(input: {
    availability: IntegrationAvailabilitySnapshot;
    allowed: ReadonlySet<string>;
    context: ToolRunContext;
  }): ToolAvailabilityResult;
}

export type WorkflowToolCatalog = ReadonlyMap<ToolName, WorkflowToolFacts>;

/**
 * Surface:  workflows.
 * Owns/hides: a read-only projection of the registry. Hides `execute` and the
 *   other RegisteredTool internals. `catalog()` returns a fresh snapshot.
 * Why the seam: inverts workflows -> tools.
 * Wiring: tool-runtime/workflow-tool-catalog-source.ts installs; workflows readiness
 *   (runtime-readiness.ts, authoring.ts, revisions.ts) reads.
 * See: ADR-0089, and docs/reference/tool-runtime-map.md.
 */
export interface WorkflowToolCatalogSource {
  catalog(): WorkflowToolCatalog;
}

const workflowToolCatalogSourcePort = bootPort<WorkflowToolCatalogSource>(
  "workflow tool-catalog source",
);

export function registerWorkflowToolCatalogSource(source: WorkflowToolCatalogSource): () => void {
  return workflowToolCatalogSourcePort.install(source);
}

function requireWorkflowToolCatalogSource(): WorkflowToolCatalogSource {
  return workflowToolCatalogSourcePort.read();
}

export function workflowToolCatalog(): WorkflowToolCatalog {
  return requireWorkflowToolCatalogSource().catalog();
}
