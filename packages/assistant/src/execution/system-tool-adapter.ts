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
  return { kind: "parked", wake: { kind: "signal", name: join.signalName } };
}

/**
 * The agent-owned implementation of the `SystemToolAgentAdapter` seam. The
 * system tools (`system.spawn_sub_agent` / `system.await_sub_agent`) call the
 * seam; this adapter forwards to the agent operations that read and write
 * agent-owned state. It lives in execution so tool-runtime never imports
 * execution (ADR-0089: the runtime composes tools, not the reverse). The
 * chat-history half of the old combined port now lives in
 * `chat/system-tool-adapter.ts`. Composition installs it at boot.
 */
const agentSystemToolAdapter: SystemToolAgentAdapter = {
  spawnSubAgent,
  readChildRunOutcome,
  resolveAwaitSubAgent,
  readScratch: readScratchEntry,
  writeScratch: writeScratchEntry,
  promoteScratch: promoteScratchEntry,
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
