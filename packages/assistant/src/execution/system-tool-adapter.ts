import {
  registerSystemToolAgentAdapter,
  type AwaitSubAgentDispatchResult,
  type JoinChildRunRequest,
  type SystemToolAgentAdapter,
} from "@alfred/assistant/tool-runtime";
import {
  promoteScratch as promoteScratchEntry,
  readScratch as readScratchEntry,
  writeScratch as writeScratchEntry,
} from "./scratchpad/index";
import { joinChildRun } from "./sub-agent-join";
import { readChildRunOutcome, spawnSubAgent } from "./sub-agents";

async function resolveAwaitSubAgent(
  args: JoinChildRunRequest,
): Promise<AwaitSubAgentDispatchResult> {
  const join = await joinChildRun(args);

  if (join.kind === "resolved") {
    return {
      kind: "executed",
      stagingId: null,
      toolResult: join.outcome,
      editedByUser: false,
    };
  }

  return { kind: "parked", wake: join.wake };
}

/**
 * Spawn and await for the system tools; installed at boot so tool-runtime does not import execution
 * (ADR-0089).
 */
const agentSystemToolAdapter: SystemToolAgentAdapter = {
  spawnSubAgent,
  readChildRunOutcome,
  resolveAwaitSubAgent,
  readScratch: readScratchEntry,
  writeScratch: writeScratchEntry,
  promoteScratch: promoteScratchEntry,
};

export function registerAgentSystemToolAdapter(): () => void {
  return registerSystemToolAgentAdapter(agentSystemToolAdapter);
}
