import type { Workflow } from "./types";
import {
  USER_AUTHORED_BRIEF_WORKFLOW_SLUG,
  userAuthoredBriefWorkflow,
} from "./workflows/user-authored-brief";

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
  return wf ?? (userAuthoredBriefWorkflow as Workflow<unknown>);
}

export function isSentinelWorkflow(workflow: Workflow<unknown>): boolean {
  return workflow.slug === USER_AUTHORED_BRIEF_WORKFLOW_SLUG;
}

export function listWorkflows(): Workflow<unknown>[] {
  return [...registry.values()];
}

/** Test-only: drop everything. Production code never calls this. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
