import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentTranscriptMessage } from "@alfred/contracts";
import {
  appendModelResponseMessages,
  isSynthesizedToolDup,
} from "../../src/modules/agent/transcript-dedup";

/**
 * Guards the Anthropic "each tool_use must have a single result" 400: the SDK
 * synthesizes its own `role:"tool"` result when the model hands a tool a
 * schema-invalid input, but our execute-less dispatcher also authors one — two
 * results for the same toolCallId fail the next turn. Both the boss and chat
 * workflows must drop the synthesized dup. (Regression: the sub-agent
 * /user-authored-brief workflow appended verbatim and crashed at boss-turn.)
 */

function toolMessage(...toolCallIds: string[]): AgentTranscriptMessage {
  return {
    role: "tool",
    content: toolCallIds.map((id) => ({
      type: "tool-result",
      toolCallId: id,
      toolName: "gmail.send_draft",
      output: { type: "json", value: { status: "invalid_input" } },
    })),
  } as AgentTranscriptMessage;
}

describe("isSynthesizedToolDup", () => {
  test("drops a tool message whose every result targets a call made this turn", () => {
    assert.equal(isSynthesizedToolDup(toolMessage("tc_1"), new Set(["tc_1"])), true);
  });

  test("keeps a tool result for some other call id (not produced this turn)", () => {
    assert.equal(isSynthesizedToolDup(toolMessage("tc_other"), new Set(["tc_1"])), false);
  });

  test("keeps a mixed tool message (some parts target other call ids)", () => {
    assert.equal(isSynthesizedToolDup(toolMessage("tc_1", "tc_other"), new Set(["tc_1"])), false);
  });

  test("ignores non-tool messages and empty content", () => {
    assert.equal(
      isSynthesizedToolDup(
        { role: "assistant", content: "hi" } as AgentTranscriptMessage,
        new Set(["tc_1"]),
      ),
      false,
    );
    assert.equal(
      isSynthesizedToolDup(
        { role: "tool", content: [] } as AgentTranscriptMessage,
        new Set(["tc_1"]),
      ),
      false,
    );
  });
});

describe("appendModelResponseMessages", () => {
  test("filters the synthesized dup but keeps the assistant tool-call message", () => {
    const transcript: AgentTranscriptMessage[] = [{ role: "user", content: "send it" }];
    const assistant: AgentTranscriptMessage = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "tc_1", toolName: "gmail.send_draft", input: {} }],
    } as AgentTranscriptMessage;
    const messages = [assistant, toolMessage("tc_1")];

    const out = appendModelResponseMessages(transcript, messages, new Set(["tc_1"]));
    assert.equal(out.length, 2, "user + assistant; the synthesized tool dup is dropped");
    assert.equal(out[1], assistant);
  });

  test("empty stepCallIds filters nothing (a turn with no tool calls)", () => {
    const transcript: AgentTranscriptMessage[] = [];
    const messages: AgentTranscriptMessage[] = [{ role: "assistant", content: "final answer" }];
    const out = appendModelResponseMessages(transcript, messages, new Set());
    assert.deepEqual(out, messages);
  });
});
