import type { Workflow } from "./types";
/**
 * In-memory workflow registry. The executor looks up `(workflowSlug)` here
 * when claiming a run; built-ins register at server boot. Decoupling
 * registration from execution lets us add user-authored workflows later
 * without forking the runtime.
 */
const registry = new Map<string, Workflow<unknown>>();

export function registerWorkflow<S>(workflow: Workflow<S>): void {
  if (registry.has(workflow.slug)) {
    throw new Error(`[agent] workflow already registered: ${workflow.slug}`);
  }
  registry.set(workflow.slug, workflow as Workflow<unknown>);
}

export function getWorkflow(slug: string): Workflow<unknown> | undefined {
  return registry.get(slug);
}

export function requireWorkflow(slug: string): Workflow<unknown> {
  const wf = registry.get(slug);
  if (!wf) {
    throw new Error(`[agent] no workflow registered for slug=${slug}`);
  }
  return wf;
}

export function listWorkflows(): Workflow<unknown>[] {
  return [...registry.values()];
}

export function isInternalWorkflowSlug(slug: string): boolean {
  return slug.startsWith("__");
}

export function listPublicWorkflows(): Workflow<unknown>[] {
  return listWorkflows().filter((workflow) => !isInternalWorkflowSlug(workflow.slug));
}

/** Test-only: drop everything. Production code never calls this. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
