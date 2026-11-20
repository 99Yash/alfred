import {
  registerResultHandleStore,
  registerSystemToolChatHistoryAdapter,
  type SystemToolChatHistoryAdapter,
} from "@alfred/assistant/tool-runtime";
import { readChatHistory } from "./chat-history-retrieval";
import { chatResultHandleStore } from "./result-handle-store";

/** Backs `system.read_chat_history`. Lives in chat so the execution layer never imports chat (ADR-0089). */
const chatSystemToolAdapter: SystemToolChatHistoryAdapter = {
  readChatHistory,
};

/**
 * Install at boot, after `registerBuiltinTools`, or the tool throws. It also installs the handle
 * store, which lives in chat because a handle lives under the thread's storage prefix.
 */
export function registerChatSystemToolAdapter(): () => void {
  const disposeHistory = registerSystemToolChatHistoryAdapter(chatSystemToolAdapter);
  const disposeHandles = registerResultHandleStore(chatResultHandleStore);

  return () => {
    disposeHandles();
    disposeHistory();
  };
}
