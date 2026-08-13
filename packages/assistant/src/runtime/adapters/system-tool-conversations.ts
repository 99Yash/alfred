import { registerConversationsSystemToolAdapter } from "@alfred/assistant/conversations";

let dispose: (() => void) | undefined;

export function registerSystemToolConversations(): void {
  dispose ??= registerConversationsSystemToolAdapter();
}

export function unregisterSystemToolConversations(): void {
  dispose?.();
  dispose = undefined;
}
