import assert from "node:assert/strict";
import test from "node:test";

import { dispatchAutonomyCallsInSafeOrder } from "../../src/modules/agent/workflows/chat-turn";

test("artifact mutations serialize in model order without blocking independent calls", async () => {
  const calls = [
    { toolName: "system.web_search", id: "lookup" },
    { toolName: "system.append_artifact_page", id: "page-1" },
    { toolName: "system.append_artifact_page", id: "page-2" },
  ];
  const events: string[] = [];
  let releaseLookup!: () => void;
  const lookupReleased = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });

  const run = dispatchAutonomyCallsInSafeOrder(calls, [false, false, false], async (call) => {
    events.push(`start:${call.id}`);
    if (call.id === "lookup") await lookupReleased;
    await Promise.resolve();
    events.push(`end:${call.id}`);
    return call.id;
  });

  // Let both lanes advance. The blocked lookup must not hold page authoring,
  // while page 2 must not begin until page 1 has committed.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, [
    "start:lookup",
    "start:page-1",
    "end:page-1",
    "start:page-2",
    "end:page-2",
  ]);

  releaseLookup();
  assert.deepEqual(await run, ["lookup", "page-1", "page-2"]);
});
