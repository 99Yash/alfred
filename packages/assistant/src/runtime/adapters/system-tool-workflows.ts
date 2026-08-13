import { registerWorkflowSystemToolAdapter } from "@alfred/assistant/automation";

let dispose: (() => void) | undefined;

export function registerSystemToolWorkflows(): void {
  dispose ??= registerWorkflowSystemToolAdapter();
}

export function unregisterSystemToolWorkflows(): void {
  dispose?.();
  dispose = undefined;
}
