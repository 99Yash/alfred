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

let readinessCheck: WorkflowReadinessCheck | undefined;

export function registerWorkflowReadinessCheck(check: WorkflowReadinessCheck): () => void {
  if (readinessCheck) {
    throw new Error("[agent] a workflow readiness check is already registered");
  }

  readinessCheck = check;

  return () => {
    if (readinessCheck === check) readinessCheck = undefined;
  };
}

/**
 * Runs on every `check-readiness` attempt, so a deferred retry sees fresh state. Throws if unwired.
 */
export async function checkWorkflowReadiness(args: {
  runId: string;
  userId: string;
}): Promise<WorkflowReadinessVerdict> {
  if (!readinessCheck) {
    throw new Error("[agent] no workflow readiness check is registered");
  }

  return readinessCheck(args);
}
