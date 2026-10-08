import {
  registerWorkflowReadinessCheck,
  type WorkflowReadinessVerdict,
} from "@alfred/assistant/execution";
import {
  checkWorkflowRunReadiness,
  type RuntimeReadinessResult,
} from "@alfred/assistant/automation";

let unregisterWorkflowReadinessCheck: (() => void) | undefined;

/**
 * Narrow the `workflows` readiness result for the execution core. Exhaustive,
 * so a new kind cannot silently drop the `deferred` retry path.
 */
export function toVerdict(result: RuntimeReadinessResult): WorkflowReadinessVerdict {
  switch (result.kind) {
    case "ready":
      return { kind: "ready" };
    case "deferred":
      return { kind: "deferred", reason: result.reason };
    case "blocked":
      return { kind: "blocked", problems: result.problems };
    default: {
      const exhaustive: never = result;

      return exhaustive;
    }
  }
}

/** Wire the readiness check without making the execution core import workflows. */
export function registerWorkflowReadiness(): void {
  if (unregisterWorkflowReadinessCheck) return;
  unregisterWorkflowReadinessCheck = registerWorkflowReadinessCheck(async (args) =>
    toVerdict(await checkWorkflowRunReadiness(args)),
  );
}

export function unregisterWorkflowReadiness(): void {
  unregisterWorkflowReadinessCheck?.();
  unregisterWorkflowReadinessCheck = undefined;
}
