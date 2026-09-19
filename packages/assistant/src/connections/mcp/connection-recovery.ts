/** A bounded probe of stalled MCP connections that still have a stored grant. */
import { PeriodicTask } from "@alfred/assistant/realtime/periodic-task";
import { boundedMcpErrorText, isMcpTransportFailure } from "./errors";
import {
  listRecoverableCredentialedConnectionIds,
  retainRecoverableConnection,
} from "./persistence";

import { getMcpConnectionManager } from "./runtime";

const RECOVERY_INTERVAL_MS = 5 * 60_000;

const RECOVERY_QUIET_MS = 2 * 60_000;

const RECOVERY_PAGE_SIZE = 10;

const task = new PeriodicTask({
  name: "mcp-connection-recovery",
  intervalMs: RECOVERY_INTERVAL_MS,
  async pass(signal) {
    const ids = await listRecoverableCredentialedConnectionIds(
      new Date(Date.now() - RECOVERY_QUIET_MS),
      RECOVERY_PAGE_SIZE,
    );

    for (const id of ids) {
      if (signal.aborted) return;

      try {
        // The manager owns the new generation, catalog publication and row state.
        await getMcpConnectionManager().getReadyClient(id);
      } catch (error) {
        // Only transport failures stay eligible. The manager stores other
        // failures, including authorization and protocol refusals.
        if (isMcpTransportFailure(error)) {
          await retainRecoverableConnection(id, boundedMcpErrorText(error));
        }
      }
    }
  },
});

export function startMcpConnectionRecovery(): void {
  task.start();
}

export async function stopMcpConnectionRecovery(): Promise<void> {
  await task.stop();
}
