import {
  registerSystemToolAgentAdapter,
  type SystemToolAgentAdapter,
} from "@alfred/assistant/tool-runtime";
import { scratchpad } from "./scratchpad/index";
import { spawnSubAgent } from "./sub-agents";

/**
 * Spawn and the writer-bound scratchpad for the system tools; installed at boot so tool-runtime
 * does not import execution (ADR-0089). The runtime joins each child, not a tool (ADR-0130
 * decision 6).
 */
const agentSystemToolAdapter: SystemToolAgentAdapter = {
  spawnSubAgent,
  scratchpad,
};

export function registerAgentSystemToolAdapter(): () => void {
  return registerSystemToolAgentAdapter(agentSystemToolAdapter);
}
