import { registerDispatchLeaseAdapter } from "@alfred/assistant/tool-runtime";
import { withStepLease } from "./executor";

/**
 * The step commit's ownership check for a dispatch claim; installed at boot so tool-runtime does
 * not import execution (ADR-0089).
 */
export function registerExecutionDispatchLeaseAdapter(): () => void {
  return registerDispatchLeaseAdapter({ withStepLease });
}
