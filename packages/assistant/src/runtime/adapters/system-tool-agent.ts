import { registerExecutionDispatchLeaseAdapter } from "@alfred/assistant/execution/dispatch-lease-adapter";
import { registerAgentSystemToolAdapter } from "@alfred/assistant/execution/system-tool-adapter";

let dispose: (() => void) | undefined;

let disposeDispatchLease: (() => void) | undefined;

/** Both execution-side tool-runtime adapters. They live as long as the agent worker. */
export function registerSystemToolAgent(): void {
  dispose ??= registerAgentSystemToolAdapter();
  disposeDispatchLease ??= registerExecutionDispatchLeaseAdapter();
}

export function unregisterSystemToolAgent(): void {
  dispose?.();
  dispose = undefined;
  disposeDispatchLease?.();
  disposeDispatchLease = undefined;
}
