import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  readChildRunOutcome,
  registerSystemToolAgentAdapter,
  spawnSubAgent,
  type SpawnSubAgentRequest,
  type SystemToolAgentAdapter,
} from "@alfred/assistant/tool-runtime";

// The seam owns no behavior: it forwards each op to the registered adapter and
// returns its result unchanged. These tests pin exactly that — a missing
// registration fails loud, a registered adapter receives the exact args and its
// result is handed straight back. Chat-history retrieval left this port in the
// chat -> conversations fold; it now has its own seam (see
// system-tool-chat-history.test.ts).

const spawnArgs: SpawnSubAgentRequest = {
  parentRunId: "run_parent",
  userId: "user_1",
  parentToolCallId: "tc_1",
  subId: "research-1",
  brief: "Summarize the thread.",
  allowedIntegrations: [],
  chat: { threadId: "thread_1", messageId: "msg_1" },
};
const childArgs = { parentRunId: "run_parent", userId: "user_1", childRunId: "run_child" };

let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("system-tool agent seam without a registered adapter", () => {
  test("each delegating op throws the boot-order error", () => {
    const message = "No system-tool agent adapter is registered";
    assert.throws(() => spawnSubAgent(spawnArgs), { message });
    assert.throws(() => readChildRunOutcome(childArgs), { message });
  });
});

describe("system-tool agent seam with a registered adapter", () => {
  test("forwards each op's args verbatim and returns its result unchanged", async () => {
    const seen: {
      spawn?: SpawnSubAgentRequest;
      child?: typeof childArgs;
    } = {};
    const spawnResult = { ok: true, status: "spawned" };
    const childResult = { ok: true, done: true, status: "completed" };
    const adapter: SystemToolAgentAdapter = {
      spawnSubAgent: (args) => {
        seen.spawn = args;
        return Promise.resolve(spawnResult);
      },
      readChildRunOutcome: (args) => {
        seen.child = args;
        return Promise.resolve(childResult);
      },
    };
    unregister = registerSystemToolAgentAdapter(adapter);

    // Same object identity out as the adapter returned — the seam adds nothing.
    assert.equal(await spawnSubAgent(spawnArgs), spawnResult);
    assert.equal(await readChildRunOutcome(childArgs), childResult);

    // Same object identity in — the seam forwards, it does not reshape.
    assert.equal(seen.spawn, spawnArgs);
    assert.equal(seen.child, childArgs);
  });

  test("a second distinct adapter is rejected", () => {
    const first: SystemToolAgentAdapter = {
      spawnSubAgent: () => Promise.resolve(null),
      readChildRunOutcome: () => Promise.resolve(null),
    };
    unregister = registerSystemToolAgentAdapter(first);
    assert.throws(() => registerSystemToolAgentAdapter({ ...first }), {
      message: "A system-tool agent adapter is already registered",
    });
    // Re-registering the SAME adapter is idempotent, not an error.
    assert.doesNotThrow(() => registerSystemToolAgentAdapter(first));
  });
});
