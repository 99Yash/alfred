import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  readChildRunOutcome,
  registerSystemToolAgentAdapter,
  resolveAwaitSubAgent,
  scratchpad,
  spawnSubAgent,
  type AwaitSubAgentDispatchResult,
  type SpawnSubAgentRequest,
  type SystemToolAgentAdapter,
  type SystemToolScratchpad,
} from "@alfred/assistant/tool-runtime";

function typecheckSafeParkCapability(): void {
  // A raw signal name does not prove the dead-man wake was scheduled.
  const unprovenPark: AwaitSubAgentDispatchResult = {
    kind: "parked",
    // @ts-expect-error plain strings are not safe-to-park capabilities
    wake: { kind: "signal", name: "sub_agent_done:run_child" },
  };

  void unprovenPark;
}

void typecheckSafeParkCapability;

// The seam only forwards to the registered adapter. A missing registration throws.

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

const scratchpadArgs = { runId: "run_parent", writer: "boss" as const };

const stubScratchpad: SystemToolScratchpad = {
  refusal: () => null,
  read: () => Promise.resolve(null),
  write: (_key, value) =>
    Promise.resolve({ value, zone: "shared", writtenBy: "boss", writtenAt: 0 }),
  promote: () => Promise.resolve(null),
};

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
    assert.throws(() => resolveAwaitSubAgent(childArgs), { message });
    assert.throws(() => scratchpad(scratchpadArgs), { message });
  });
});

describe("system-tool agent seam with a registered adapter", () => {
  test("forwards each op's args verbatim and returns its result unchanged", async () => {
    interface SeenOps {
      spawn?: SpawnSubAgentRequest;
      child?: typeof childArgs;
      join?: typeof childArgs;
      scratchpad?: Parameters<SystemToolAgentAdapter["scratchpad"]>[0];
    }

    const seen: SeenOps = {};

    const spawnResult = {
      ok: true,
      status: "spawned",
      parentRunId: "run_parent",
      childRunId: "run_child",
      subId: "sub_1",
    } as const;

    const childResult = { ok: true, done: true, status: "completed" };

    const joinResult = {
      kind: "executed" as const,
      stagingId: null,
      toolResult: childResult,
      editedByUser: false as const,
    };

    const adapter: SystemToolAgentAdapter = {
      spawnSubAgent: (args) => {
        seen.spawn = args;

        return Promise.resolve(spawnResult);
      },
      readChildRunOutcome: (args) => {
        seen.child = args;

        return Promise.resolve(childResult);
      },
      resolveAwaitSubAgent: (args) => {
        seen.join = args;

        return Promise.resolve(joinResult);
      },
      scratchpad: (args) => {
        seen.scratchpad = args;

        return stubScratchpad;
      },
    };

    unregister = registerSystemToolAgentAdapter(adapter);

    assert.equal(await spawnSubAgent(spawnArgs), spawnResult);
    assert.equal(await readChildRunOutcome(childArgs), childResult);
    assert.equal(await resolveAwaitSubAgent(childArgs), joinResult);
    assert.equal(scratchpad(scratchpadArgs), stubScratchpad);

    assert.equal(seen.spawn, spawnArgs);
    assert.equal(seen.child, childArgs);
    assert.equal(seen.join, childArgs);
    assert.equal(seen.scratchpad, scratchpadArgs);
  });

  test("a second distinct adapter is rejected", () => {
    const first: SystemToolAgentAdapter = {
      spawnSubAgent: () =>
        Promise.resolve({
          ok: true,
          status: "spawned",
          parentRunId: "run_parent",
          childRunId: "run_child",
          subId: "sub_1",
        } as const),
      readChildRunOutcome: () =>
        Promise.resolve({ ok: true, done: true, status: "completed" } as const),
      resolveAwaitSubAgent: () =>
        Promise.resolve({
          kind: "executed",
          stagingId: null,
          toolResult: null,
          editedByUser: false,
        }),
      scratchpad: () => stubScratchpad,
    };

    unregister = registerSystemToolAgentAdapter(first);
    assert.throws(() => registerSystemToolAgentAdapter({ ...first }), {
      message: "A system-tool agent adapter is already registered",
    });
    assert.doesNotThrow(() => registerSystemToolAgentAdapter(first));
  });
});
