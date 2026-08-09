// The durable-execution module owns only the readiness verdict shape its
// `check-readiness` step reads; the concrete check lives in `workflows` and is
// wired in at boot by the composition layer (see
// `composition/workflow-readiness.ts`). This keeps `agent` from importing
// `workflows` — the last product edge the execution core sheds (ADR-0089) —
// mirroring how `integrations/workflow-recovery.ts` receives its checker.

// `problems` is forwarded opaquely into the blocked step-output; the engine
// never inspects a problem's fields, so the port keeps them as `unknown`.
export type WorkflowReadinessVerdict =
  | { kind: "ready" }
  | { kind: "blocked"; problems: readonly unknown[] }
  | { kind: "deferred"; reason: string };

export type WorkflowReadinessCheck = (args: {
  runId: string;
  userId: string;
}) => Promise<WorkflowReadinessVerdict>;

let readinessCheck: WorkflowReadinessCheck | undefined;

/** Register the readiness check that runtime composition supplies. */
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
 * Re-evaluate one run's readiness through the registered check. Called live on
 * every attempt of the sentinel's `check-readiness` step (it defers-and-retries
 * on transient provider trouble, so a value computed once at run start would be
 * stale). Throws loudly if unwired — it never treats "unregistered" as "ready".
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
