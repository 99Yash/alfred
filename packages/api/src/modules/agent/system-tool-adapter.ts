import { registerSystemToolAgentAdapter, type SystemToolAgentAdapter } from "../tool-runtime";
import { readChatHistory } from "./chat-history-retrieval";
import { readChildRunOutcome, spawnSubAgent } from "./sub-agents";

/**
 * The agent-owned implementation of the `SystemToolAgentAdapter` seam. The
 * system tools (`system.spawn_sub_agent` / `system.await_sub_agent` /
 * `system.read_chat_history`) call the seam; this adapter forwards to the agent
 * operations that read and write agent-owned state. It lives in the agent module
 * so the tools module never imports agent (ADR-0089: the runtime composes tools,
 * not the reverse). Composition installs it at boot.
 */
const agentSystemToolAdapter: SystemToolAgentAdapter = {
  spawnSubAgent,
  readChildRunOutcome,
  readChatHistory,
};

/**
 * Install the agent-behavior handler behind the tool-runtime seam. The
 * composition root calls this after `registerBuiltinTools`, so a system tool
 * that reaches the seam finds a registered adapter rather than the boot-order
 * throw.
 */
export function registerAgentSystemToolAdapter(): () => void {
  return registerSystemToolAgentAdapter(agentSystemToolAdapter);
}
