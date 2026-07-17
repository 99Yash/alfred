import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentTranscriptMessage } from "@alfred/contracts";

import {
  estimateNextTurnInputTokens,
  estimateTranscriptTokens,
  shouldSkipCompaction,
} from "../../src/modules/agent/compaction/tokens";

describe("authored-brief compaction pressure (#369)", () => {
  const smallPriorChars = 10_000;
  const minimumPriorChars = 20_000;
  const pressureThresholdTokens = 100;

  test("next-turn estimate includes prior billed overhead and the complete in-flight tail", () => {
    const inFlightTail: AgentTranscriptMessage[] = [
      { role: "assistant", content: "calling a tool" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read",
            output: { type: "text", value: "result" },
          },
        ],
      },
    ];

    assert.equal(
      estimateNextTurnInputTokens({ priorInputTokens: 75, inFlightTail }),
      75 + estimateTranscriptTokens(inFlightTail),
    );
  });

  test("Guard 2 does not skip when billed system and tool overhead caused pressure", () => {
    const transcriptOnlyTokens = 25;
    const nextTurnInputTokens = 125;

    assert.ok(transcriptOnlyTokens <= pressureThresholdTokens, "old transcript-only guard skips");
    assert.equal(
      shouldSkipCompaction({
        priorChars: smallPriorChars,
        minimumPriorChars,
        nextTurnInputTokens,
        pressureThresholdTokens,
      }),
      false,
    );
  });

  test("Guard 2 still skips a small prior when the canonical next-turn estimate fits", () => {
    assert.equal(
      shouldSkipCompaction({
        priorChars: smallPriorChars,
        minimumPriorChars,
        nextTurnInputTokens: pressureThresholdTokens,
        pressureThresholdTokens,
      }),
      true,
    );
  });

  test("Guard 2 compacts a substantial prior even when the next turn fits", () => {
    assert.equal(
      shouldSkipCompaction({
        priorChars: minimumPriorChars,
        minimumPriorChars,
        nextTurnInputTokens: pressureThresholdTokens - 1,
        pressureThresholdTokens,
      }),
      false,
    );
  });
});
