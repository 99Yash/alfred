import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { StreamingMessage } from "../../src/lib/chat/chat-stream-state";
import { shouldShowThinkingIndicator } from "../../src/routes/-chat/conversation-helpers";

const BLANK: StreamingMessage = {
  messageId: "m1",
  runId: "r1",
  text: "",
  narration: [],
  reasoning: "",
  reasoningActive: false,
  reasoningMs: null,
  tools: [],
  connectNudges: [],
  subAgents: [],
  awaitingApproval: false,
  compacting: false,
  done: false,
  error: null,
};

const stream = (over: Partial<StreamingMessage>): StreamingMessage => ({ ...BLANK, ...over });

describe("shouldShowThinkingIndicator", () => {
  test("a running turn with nothing to show yet spins", () => {
    assert.equal(shouldShowThinkingIndicator(BLANK), true);
  });

  // The bug: `shouldShowStream` keeps the live bubble mounted until the durable
  // row syncs in, so a turn stopped before its first delta is `done` with an
  // empty everything for that whole window. It must not spin.
  test("a done turn with nothing to show does not spin", () => {
    assert.equal(shouldShowThinkingIndicator(stream({ done: true })), false);
  });

  test("closed narration is not live activity — a running turn still spins under it", () => {
    assert.equal(
      shouldShowThinkingIndicator(stream({ narration: [{ index: 0, text: "Looking" }] })),
      true,
    );
  });

  test("any other in-flow indicator wins", () => {
    assert.equal(shouldShowThinkingIndicator(stream({ compacting: true })), false);
    assert.equal(shouldShowThinkingIndicator(stream({ text: "Sure" })), false);
    assert.equal(shouldShowThinkingIndicator(stream({ reasoning: "hmm" })), false);
    assert.equal(shouldShowThinkingIndicator(stream({ reasoningActive: true })), false);
    assert.equal(
      shouldShowThinkingIndicator(
        stream({
          tools: [
            {
              toolCallId: "t1",
              toolName: "gmail.search",
              status: "started",
              segmentIndex: 0,
              startedTs: 0,
              endedTs: null,
            },
          ],
        }),
      ),
      false,
    );
  });
});
