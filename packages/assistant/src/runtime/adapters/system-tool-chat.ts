import { registerChatSystemToolAdapter } from "@alfred/assistant/chat";

let dispose: (() => void) | undefined;

export function registerSystemToolChat(): void {
  dispose ??= registerChatSystemToolAdapter();
}

export function unregisterSystemToolChat(): void {
  dispose?.();
  dispose = undefined;
}
