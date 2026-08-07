import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { readChatHistoryInput } from "@alfred/contracts";

import {
  readChatHistory,
  registerSystemToolChatHistoryAdapter,
  type SystemToolChatHistoryAdapter,
} from "../../src/modules/tool-runtime";

// The chat-history seam owns no behavior: it forwards `readChatHistory` to the
// registered adapter and returns its result unchanged. This port split out of
// `SystemToolAgentAdapter` in the chat -> conversations fold, so conversations
// installs it (agent installs only spawn/join). These tests pin the same shape
// the agent seam test pins: a missing registration fails loud, a registered
// adapter receives the exact args and its result is handed straight back.

const historyArgs = {
  userId: "user_1",
  threadId: "thread_1",
  input: readChatHistoryInput.parse({ mode: "search", query: "invoice", limit: 3 }),
};

let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("system-tool chat-history seam without a registered adapter", () => {
  test("readChatHistory throws the boot-order error", () => {
    assert.throws(() => readChatHistory(historyArgs), {
      message: "No system-tool chat-history adapter is registered",
    });
  });
});

describe("system-tool chat-history seam with a registered adapter", () => {
  test("forwards args verbatim and returns its result unchanged", async () => {
    let seen: typeof historyArgs | undefined;
    const historyResult = { ok: true, mode: "search", results: [] };
    const adapter: SystemToolChatHistoryAdapter = {
      readChatHistory: (args) => {
        seen = args;
        return Promise.resolve(historyResult);
      },
    };
    unregister = registerSystemToolChatHistoryAdapter(adapter);

    // Same object identity out as the adapter returned — the seam adds nothing.
    assert.equal(await readChatHistory(historyArgs), historyResult);
    // Same object identity in — the seam forwards, it does not reshape.
    assert.equal(seen, historyArgs);
  });

  test("a second distinct adapter is rejected", () => {
    const first: SystemToolChatHistoryAdapter = {
      readChatHistory: () => Promise.resolve(null),
    };
    unregister = registerSystemToolChatHistoryAdapter(first);
    assert.throws(() => registerSystemToolChatHistoryAdapter({ ...first }), {
      message: "A system-tool chat-history adapter is already registered",
    });
    // Re-registering the SAME adapter is idempotent, not an error.
    assert.doesNotThrow(() => registerSystemToolChatHistoryAdapter(first));
  });
});
