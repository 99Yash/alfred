import { canonicalJson, type WorkflowRevisionDefinition } from "@alfred/contracts";
import { sha256Canonical } from "../../lib/hash";

/**
 * The content hash of a workflow revision (#555).
 *
 * `revise` compares this digest against the current revision before it appends
 * a row, so a save that changes nothing semantic — the same tools listed in a
 * different order, a re-serialized trigger — is a no-op instead of a new
 * revision the user has to re-approve.
 *
 * Two properties make that comparison trustworthy:
 *
 *   1. **Key order cannot matter.** `canonicalJson` sorts object keys, so the
 *      pre-image is identical in two processes and after a JSON round-trip.
 *   2. **Set order cannot matter.** `canonicalJson` preserves array order, and
 *      `allowedIntegrations` / `allowedTools` / `requiredCapabilities` are
 *      sets, not sequences. {@link canonicalWorkflowDefinition} sorts them
 *      first — without that, re-running the capability resolver over the same
 *      inputs could mint a revision purely from iteration order.
 *
 * The digest deliberately covers the definition only. The authoring proposal,
 * the pointers, the revision number and the timestamps are excluded: a reworded
 * assumption is not a different contract.
 */
export function workflowRevisionContentHash(definition: WorkflowRevisionDefinition): string {
  return sha256Canonical(canonicalWorkflowDefinition(definition));
}

/**
 * The definition in its canonical form: set-valued fields sorted, everything
 * else untouched. Exported because the same normalization is what gets stored,
 * so a row read back re-hashes to the value in its `content_hash` column.
 */
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

/**
 * Total order over capabilities: tool, then account, then the canonical form of
 * the resource scope. Comparing the scope through `canonicalJson` rather than
 * an object identity keeps two structurally equal scopes from sorting
 * arbitrarily against each other.
 */
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
