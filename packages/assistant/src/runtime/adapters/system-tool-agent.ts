import { registerAgentSystemToolAdapter } from "@alfred/assistant/execution/system-tool-adapter";

let dispose: (() => void) | undefined;

export function registerSystemToolAgent(): void {
  dispose ??= registerAgentSystemToolAdapter();
}

export function unregisterSystemToolAgent(): void {
  dispose?.();
  dispose = undefined;
}
