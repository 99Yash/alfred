import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureOutput } from "../src/metering/wrappers";

/**
 * `result.text` is empty on a tool-call turn, so the trace lost the decision.
 * A bare string for a text turn; tool calls folded in when the turn has any.
 */

describe("captureOutput", () => {
  test("returns the bare string when there are no tool calls (final / object turn)", () => {
    assert.equal(captureOutput({ text: "the answer" }), "the answer");
    assert.equal(
      captureOutput({ text: '{"category":"fyi"}', toolCalls: [] }),
      '{"category":"fyi"}',
    );
  });

  test("captures the proposed calls on a tool-call turn with no prose (was NULL before)", () => {
    const out = captureOutput({
      text: "",
      toolCalls: [{ toolName: "github.search", toolCallId: "call_1", input: { q: "is:open" } }],
    });

    assert.deepEqual(out, {
      toolCalls: [{ toolName: "github.search", toolCallId: "call_1", input: { q: "is:open" } }],
    });
  });

  test("keeps both narration text and tool calls on an interleaved turn", () => {
    const out = captureOutput({
      text: "Let me check that.",
      toolCalls: [
        { toolName: "drive.search_files", toolCallId: "c1", input: { query: "SOW" } },
        { toolName: "system.read_user_context", toolCallId: "c2", input: { query: "client" } },
      ],
    });

    assert.deepEqual(out, {
      text: "Let me check that.",
      toolCalls: [
        { toolName: "drive.search_files", toolCallId: "c1", input: { query: "SOW" } },
        { toolName: "system.read_user_context", toolCallId: "c2", input: { query: "client" } },
      ],
    });
  });

  test("projects only name/id/input — drops any extra SDK fields off the call", () => {
    const sdkCall = Object.assign(
      {
        toolName: "calendar.list_events",
        toolCallId: "c9",
        input: { range: "next_7_days" },
      },
      { type: "tool-call", providerMetadata: { anthropic: {} } },
    );

    const out = captureOutput({ text: "", toolCalls: [sdkCall] });
    assert.deepEqual(out, {
      toolCalls: [
        { toolName: "calendar.list_events", toolCallId: "c9", input: { range: "next_7_days" } },
      ],
    });
  });
});
