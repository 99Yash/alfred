import { registerWorkflowReadinessCheck, type WorkflowReadinessVerdict } from "@alfred/assistant/execution";
import {
  checkWorkflowRunReadiness,
  type RuntimeReadinessResult,
} from "../modules/workflows/runtime-readiness";

let unregisterWorkflowReadinessCheck: (() => void) | undefined;

/**
 * Map the rich `workflows` readiness result into the narrow verdict the
 * execution core reads. Exhaustive over every `RuntimeReadinessResult` kind — a
 * dropped kind fails to compile at the `satisfies never` line, so the
 * defer-and-retry (`deferred`) path can never be silently lost. The core never
 * sees `newlyBlocked`; it forwards `problems` opaquely into blocked step-output.
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
