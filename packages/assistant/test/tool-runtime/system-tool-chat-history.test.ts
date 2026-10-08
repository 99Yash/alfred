import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { readChatHistoryInput } from "@alfred/contracts";

import {
  readChatHistory,
  registerSystemToolChatHistoryAdapter,
  type SystemToolChatHistoryAdapter,
} from "@alfred/assistant/tool-runtime";

// The seam only forwards `readChatHistory` to the registered adapter. A missing registration
// throws.

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
    const historyResult = { ok: true, mode: "search", query: "invoice", results: [] } as const;

    const adapter: SystemToolChatHistoryAdapter = {
      readChatHistory: (args) => {
        seen = args;

        return Promise.resolve(historyResult);
      },
    };

    unregister = registerSystemToolChatHistoryAdapter(adapter);

    assert.equal(await readChatHistory(historyArgs), historyResult);
    assert.equal(seen, historyArgs);
  });

  test("a second distinct adapter is rejected", () => {
    const first: SystemToolChatHistoryAdapter = {
      readChatHistory: () =>
        Promise.resolve({
          ok: true,
          mode: "fetch",
          found: false,
          kind: "message",
          id: "x",
        } as const),
    };

    unregister = registerSystemToolChatHistoryAdapter(first);
    assert.throws(() => registerSystemToolChatHistoryAdapter({ ...first }), {
      message: "A system-tool chat-history adapter is already registered",
    });
    assert.doesNotThrow(() => registerSystemToolChatHistoryAdapter(first));
  });
});
