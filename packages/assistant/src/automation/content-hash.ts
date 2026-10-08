import { canonicalJson, type WorkflowRevisionDefinition } from "@alfred/contracts";
import { sha256Canonical } from "@alfred/db/hash";

/**
 * Content hash of a workflow revision (#555). `revise` compares it so a save with no
 * semantic change is a no-op, not a new revision to re-approve.
 * `canonicalJson` sorts keys; {@link canonicalWorkflowDefinition} sorts the set-valued
 * arrays, so iteration order cannot mint a revision.
 * Covers the definition only: a reworded proposal is not a different contract.
 */
export function workflowRevisionContentHash(definition: WorkflowRevisionDefinition): string {
  return sha256Canonical(canonicalWorkflowDefinition(definition));
}

/** Set-valued fields sorted. This form is also what is stored, so a read-back re-hashes the same. */
export function canonicalWorkflowDefinition(
  definition: WorkflowRevisionDefinition,
): WorkflowRevisionDefinition {
  return {
    name: definition.name,
    description: definition.description,
    brief: definition.brief,
    trigger: definition.trigger,
    allowedIntegrations: [...definition.allowedIntegrations].sort(),
    allowedTools: [...definition.allowedTools].sort(),
    requiredCapabilities: [...definition.requiredCapabilities].sort(compareCapabilities),
  };
}

/** Order by tool, account, then canonical scope JSON, so equal scopes sort the same. */
function compareCapabilities(
  a: WorkflowRevisionDefinition["requiredCapabilities"][number],
  b: WorkflowRevisionDefinition["requiredCapabilities"][number],
): number {
  if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
  const accountA = a.accountRef ?? "";
  const accountB = b.accountRef ?? "";

  if (accountA !== accountB) return accountA < accountB ? -1 : 1;
  const scopeA = canonicalJson(a.resourceScope ?? null);
  const scopeB = canonicalJson(b.resourceScope ?? null);

  if (scopeA === scopeB) return 0;

  return scopeA < scopeB ? -1 : 1;
}
