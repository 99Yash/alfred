import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { StreamingMessage } from "../../src/lib/chat/chat-stream-state";
import { resolveToolCall } from "../../src/lib/chat/resolved-tool-call";
import { shouldShowThinkingIndicator } from "../../src/routes/-chat/conversation-helpers";

const BLANK: StreamingMessage = {
  messageId: "m1",
  runId: "r1",
  text: "",
  narration: [],
  reasoning: "",
  reasoningActive: false,
  stepReasoning: "",
  turnStartedTs: 0,
  reasoningMs: null,
  tools: [],
  connectNudges: [],
  subAgents: [],
  awaitingApproval: false,
  compacting: false,
  awaitingCapacity: false,
  done: false,
  error: null,
};

const stream = (over: Partial<StreamingMessage>): StreamingMessage => ({ ...BLANK, ...over });

describe("shouldShowThinkingIndicator", () => {
  test("a running turn with nothing to show yet spins", () => {
    assert.equal(shouldShowThinkingIndicator(BLANK, false), true);
  });

  // `shouldShowStream` keeps the bubble until the row syncs, so a turn stopped before any delta is done and empty.
  test("a done turn with nothing to show does not spin", () => {
    assert.equal(shouldShowThinkingIndicator(stream({ done: true }), false), false);
  });

  test("closed narration is not live activity — a running turn still spins under it", () => {
    assert.equal(
      shouldShowThinkingIndicator(stream({ narration: [{ index: 0, text: "Looking" }] }), false),
      true,
    );
  });

  // A later step thinks again after the first step's thinking closed.
  test("closed thinking is not live activity — a running turn still spins under it", () => {
    assert.equal(shouldShowThinkingIndicator(stream({ reasoning: "hmm" }), false), true);
  });

  test("any other in-flow indicator wins", () => {
    assert.equal(shouldShowThinkingIndicator(stream({ compacting: true }), false), false);
    assert.equal(shouldShowThinkingIndicator(stream({ text: "Sure" }), false), false);
    assert.equal(shouldShowThinkingIndicator(stream({ reasoningActive: true }), false), false);
    assert.equal(
      shouldShowThinkingIndicator(
        stream({
          tools: [
            {
              ...resolveToolCall({
                toolCallId: "t1",
                toolName: "gmail.search",
                status: "started",
                segmentIndex: 0,
              }),
              argsPreview: undefined,
              startedTs: 0,
              endedTs: null,
            },
          ],
        }),
        false,
      ),
      false,
    );
  });
});
