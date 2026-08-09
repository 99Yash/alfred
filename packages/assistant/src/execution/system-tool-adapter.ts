import {
  registerSystemToolAgentAdapter,
  type SystemToolAgentAdapter,
} from "@alfred/assistant/tool-runtime";
import { readChildRunOutcome, spawnSubAgent } from "./sub-agents";

/**
 * The agent-owned implementation of the `SystemToolAgentAdapter` seam. The
 * system tools (`system.spawn_sub_agent` / `system.await_sub_agent`) call the
 * seam; this adapter forwards to the agent operations that read and write
 * agent-owned state. It lives in the agent module so the tools module never
 * imports agent (ADR-0089: the runtime composes tools, not the reverse). The
 * chat-history half of the old combined port now lives in
 * `conversations/system-tool-adapter.ts`. Composition installs it at boot.
 */
const agentSystemToolAdapter: SystemToolAgentAdapter = {
  spawnSubAgent,
  readChildRunOutcome,
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
