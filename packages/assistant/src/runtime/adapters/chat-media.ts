import { registerChatMediaAdapter } from "@alfred/assistant/chat";

let dispose: (() => void) | undefined;

export function registerChatMedia(): void {
  dispose ??= registerChatMediaAdapter();
}

export function unregisterChatMedia(): void {
  dispose?.();
  dispose = undefined;
}
