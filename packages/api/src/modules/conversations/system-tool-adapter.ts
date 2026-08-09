import {
  registerSystemToolChatHistoryAdapter,
  type SystemToolChatHistoryAdapter,
} from "@alfred/assistant/tool-runtime";
import { readChatHistory } from "./chat-history-retrieval";

/**
 * The conversations-owned implementation of the `SystemToolChatHistoryAdapter`
 * seam. The `system.read_chat_history` tool calls the seam; this adapter
 * forwards to the conversations retrieval that reads chat-message and attachment
 * state. It lives in the conversations module so the generic execution layer
 * (`agent`, `tools`) never imports a product recipe (ADR-0089). It installs over
 * the already-existing `conversations -> tool-runtime` edge, so folding chat into
 * conversations adds no new module edge. Composition installs it at boot.
 */
const conversationsSystemToolAdapter: SystemToolChatHistoryAdapter = {
  readChatHistory,
};

/**
 * Install the chat-history handler behind the tool-runtime seam. The composition
 * root calls this after `registerBuiltinTools`, beside
 * `registerAgentSystemToolAdapter`, so a `system.read_chat_history` call finds a
 * registered adapter rather than the boot-order throw.
 */
export function registerConversationsSystemToolAdapter(): () => void {
  return registerSystemToolChatHistoryAdapter(conversationsSystemToolAdapter);
}
