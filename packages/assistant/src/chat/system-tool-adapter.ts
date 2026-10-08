import {
  registerSystemToolChatHistoryAdapter,
  type SystemToolChatHistoryAdapter,
} from "@alfred/assistant/tool-runtime";
import { readChatHistory } from "./chat-history-retrieval";

/** Backs `system.read_chat_history`. Lives in chat so the execution layer never imports chat (ADR-0089). */
const chatSystemToolAdapter: SystemToolChatHistoryAdapter = {
  readChatHistory,
};

/** Install at boot, after `registerBuiltinTools`, or the tool throws. */
export function registerChatSystemToolAdapter(): () => void {
  return registerSystemToolChatHistoryAdapter(chatSystemToolAdapter);
}
