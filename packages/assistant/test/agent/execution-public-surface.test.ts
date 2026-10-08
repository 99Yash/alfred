import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as agentBarrel from "@alfred/assistant/execution";

/**
 * Outside the execution module, a run starts only through `startRun`,
 * `startRunInTx`, `redeliverRun`, or `persistChatTurnRunInTx`. The barrel must not
 * re-export the raw `createRun`/`enqueueRun` pair; their subfiles still export them.
 */
describe("execution public run-start surface (item 09)", () => {
  // Widen to a record: naming a missing export directly is a compile error.
  const asRecord = (m: Record<string, unknown>): Record<string, unknown> => m;

  const FOLDED_AND_NARROW = ["startRun", "startRunInTx", "redeliverRun"] as const;
  const REMOVED_PAIR = ["createRun", "enqueueRun", "deliverRun"] as const;

  test("agent barrel exposes the folded + narrow ops, not the raw create/enqueue pair", () => {
    const barrel = asRecord(agentBarrel);

    for (const name of [...FOLDED_AND_NARROW, "persistChatTurnRunInTx"]) {
      assert.equal(typeof barrel[name], "function", `barrel must export ${name}`);
    }

    for (const name of REMOVED_PAIR) {
      assert.equal(barrel[name], undefined, `barrel must NOT re-export ${name}`);
    }
  });
});
