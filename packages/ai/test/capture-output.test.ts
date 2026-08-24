import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureOutput } from "../src/metering/wrappers";

/**
 * `captureOutput` is the fix for the lossy generation trace (#214 follow-up):
 * `result.text` alone records `null`/empty on a tool-call turn (the model emits
 * no prose), losing the turn's decision. A trajectory replay reads the captured
 * output to learn what the model chose, so these cases pin the shape:
 *  - bare string for a plain/final or structured-object turn (no regression),
 *  - tool calls folded in whenever the turn proposes any.
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
    // Extra fields the SDK may carry (type, providerMetadata, dynamic) ride along
    // exactly as fetch would deliver them.
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
