import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sanitizeChatMessageFields } from "@alfred/assistant/chat/chat-turn-closure";
import { chatRunStateSchema } from "@alfred/assistant/chat/chat-turn-state";
import { resetToolFixtures } from "@alfred/assistant/tool-runtime/test-support";

/**
 * The connect nudge's slug is a closed enum (registry plan PR 1). A checkpoint
 * is the second persisted door it passes through, after the message row: a run
 * checkpointed by a build whose registry knew a slug this build does not must
 * resume, not fail its state parse. The nudge reads as absent, so the bounce
 * stays internal plumbing and the sibling entries are untouched.
 */
describe("chatRunStateSchema.toolCallsLog[].connectNudge", () => {
  test("a checkpoint with a nudge this build cannot read resumes without the nudge", () => {
    resetToolFixtures();
    const state = chatRunStateSchema.parse({
      threadId: "thr_1",
      messageId: "msg_1",
      tier: "standard",
      allowedIntegrations: [],
      pendingToolCalls: [],
      activeTools: [],
      toolCallsLog: [
        { toolCallId: "a", toolName: "calendar.list_events", status: "succeeded" },
        {
          toolCallId: "b",
          toolName: "github.request",
          status: "failed",
          nonExecution: true,
          // NUL-bearing, the ADR-0070 poison shape: never a registry slug.
          connectNudge: { integration: "gith\u0000ub", action: "connect" },
        },
        {
          toolCallId: "c",
          toolName: "gmail.search",
          status: "failed",
          nonExecution: true,
          connectNudge: { integration: "gmail", action: "connect" },
        },
      ],
    });

    assert.equal(state.toolCallsLog[1]?.connectNudge, undefined);
    assert.deepEqual(state.toolCallsLog[2]?.connectNudge, {
      integration: "gmail",
      action: "connect",
    });

    // The unreadable bounce is now a plain non-execution: it leaves the
    // persisted trail, while the card and the readable repair stay.
    const persisted = sanitizeChatMessageFields(state).toolCalls ?? [];
    assert.deepEqual(
      persisted.map((call) => call.toolCallId),
      ["a", "c"],
    );
  });
});
