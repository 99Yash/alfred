import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  promoteScratch,
  readScratch,
  readChildRunOutcome,
  registerSystemToolAgentAdapter,
  resolveAwaitSubAgent,
  spawnSubAgent,
  writeScratch,
  type AwaitSubAgentDispatchResult,
  type SpawnSubAgentRequest,
  type SystemToolAgentAdapter,
  type SystemToolScratchRead,
  type SystemToolScratchWrite,
} from "@alfred/assistant/tool-runtime";

function typecheckSafeParkCapability(): void {
  // A raw signal name is not evidence that execution scheduled the dead-man
  // wake. This negative type pin fails if the adapter port becomes structurally
  // constructible again.
  const unprovenPark: AwaitSubAgentDispatchResult = {
    kind: "parked",
    // @ts-expect-error plain strings are not safe-to-park capabilities
    wake: { kind: "signal", name: "sub_agent_done:run_child" },
  };
  void unprovenPark;
}
void typecheckSafeParkCapability;

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
const scratchReadArgs = { runId: "run_parent", zone: "shared" as const, path: "facts" };
const scratchWriteArgs = {
  ...scratchReadArgs,
  value: { answer: 42 },
  writtenBy: "boss",
};
const scratchPromoteArgs = {
  runId: "run_parent",
  fromSubId: "research-1",
  fromPath: "facts",
  toSharedPath: "facts",
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
    assert.throws(() => readScratch(scratchReadArgs), { message });
    assert.throws(() => writeScratch(scratchWriteArgs), { message });
    assert.throws(() => promoteScratch(scratchPromoteArgs), { message });
  });
});

describe("system-tool agent seam with a registered adapter", () => {
  test("forwards each op's args verbatim and returns its result unchanged", async () => {
    const seen: {
      spawn?: SpawnSubAgentRequest;
      child?: typeof childArgs;
      join?: typeof childArgs;
      scratchRead?: SystemToolScratchRead;
      scratchWrite?: SystemToolScratchWrite;
      scratchPromote?: typeof scratchPromoteArgs;
    } = {};
    const spawnResult = { ok: true, status: "spawned" };
    const childResult = { ok: true, done: true, status: "completed" };
    const joinResult = {
      kind: "executed" as const,
      stagingId: null,
      toolResult: childResult,
      editedByUser: false as const,
    };
    const scratchReadResult = { value: { answer: 42 } };
    const scratchPromoteResult = { value: { answer: 42 }, zone: "shared" };
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
      readScratch: (args) => {
        seen.scratchRead = args;
        return Promise.resolve(scratchReadResult);
      },
      writeScratch: (args) => {
        seen.scratchWrite = args;
        return Promise.resolve(undefined);
      },
      promoteScratch: (args) => {
        seen.scratchPromote = args;
        return Promise.resolve(scratchPromoteResult);
      },
    };
    unregister = registerSystemToolAgentAdapter(adapter);

    // Same object identity out as the adapter returned — the seam adds nothing.
    assert.equal(await spawnSubAgent(spawnArgs), spawnResult);
    assert.equal(await readChildRunOutcome(childArgs), childResult);
    assert.equal(await resolveAwaitSubAgent(childArgs), joinResult);
    assert.equal(await readScratch(scratchReadArgs), scratchReadResult);
    assert.equal(await writeScratch(scratchWriteArgs), undefined);
    assert.equal(await promoteScratch(scratchPromoteArgs), scratchPromoteResult);

    // Same object identity in — the seam forwards, it does not reshape.
    assert.equal(seen.spawn, spawnArgs);
    assert.equal(seen.child, childArgs);
    assert.equal(seen.join, childArgs);
    assert.equal(seen.scratchRead, scratchReadArgs);
    assert.equal(seen.scratchWrite, scratchWriteArgs);
    assert.equal(seen.scratchPromote, scratchPromoteArgs);
  });

  test("a second distinct adapter is rejected", () => {
    const first: SystemToolAgentAdapter = {
      spawnSubAgent: () => Promise.resolve(null),
      readChildRunOutcome: () => Promise.resolve(null),
      resolveAwaitSubAgent: () =>
        Promise.resolve({
          kind: "executed",
          stagingId: null,
          toolResult: null,
          editedByUser: false,
        }),
      readScratch: () => Promise.resolve(null),
      writeScratch: () => Promise.resolve(undefined),
      promoteScratch: () => Promise.resolve(null),
    };
    unregister = registerSystemToolAgentAdapter(first);
    assert.throws(() => registerSystemToolAgentAdapter({ ...first }), {
      message: "A system-tool agent adapter is already registered",
    });
    // Re-registering the SAME adapter is idempotent, not an error.
    assert.doesNotThrow(() => registerSystemToolAgentAdapter(first));
  });
});
