import { bootPort } from "@alfred/assistant/boot-port";

// The real check is wired at boot (`runtime/adapters/workflow-readiness.ts`),
// so execution does not import `workflows` (ADR-0089).

// The engine never reads `problems`, so they stay `unknown`.
export type WorkflowReadinessVerdict =
  | { kind: "ready" }
  | { kind: "blocked"; problems: readonly unknown[] }
  | { kind: "deferred"; reason: string };

export type WorkflowReadinessCheck = (args: {
  runId: string;
  userId: string;
}) => Promise<WorkflowReadinessVerdict>;

const workflowReadinessCheckPort = bootPort<WorkflowReadinessCheck>("workflow readiness check");

export function registerWorkflowReadinessCheck(check: WorkflowReadinessCheck): () => void {
  return workflowReadinessCheckPort.install(check);
}

/**
 * Runs on every `check-readiness` attempt, so a deferred retry sees fresh state. Throws if unwired.
 */
export async function checkWorkflowReadiness(args: {
  runId: string;
  userId: string;
}): Promise<WorkflowReadinessVerdict> {
  return workflowReadinessCheckPort.read()(args);
}
