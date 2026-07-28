import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { SPAWN_SUB_AGENT_TOOL } from "@alfred/contracts";

import { buildTrail } from "../../src/routes/-chat/trail";
import type { ToolCallView } from "../../src/routes/-chat/tool-call-presentation";

const call = (
  toolName: string,
  status: ToolCallView["status"],
  segmentIndex?: number,
  toolCallId = `${toolName}-${segmentIndex ?? 0}`,
): ToolCallView => ({ toolCallId, toolName, status, segmentIndex });

const kinds = (items: ReturnType<typeof buildTrail>) => items.map((i) => i.kind);

describe("buildTrail", () => {
  // The bug this item exists for: a step whose cards all retracted (every call
  // bounced `nonExecution`) leaves closed prose with zero cards. The trail must
  // still have a row, or the consumer's emptiness test eats prose the user read.
  test("narration with no tools at all is still a row", () => {
    const trail = buildTrail([], [{ index: 0, text: "Checking your calendar" }]);
    assert.deepEqual(kinds(trail), ["narration"]);
    assert.equal(trail[0]?.kind === "narration" && trail[0].text, "Checking your calendar");
  });

  test("blank and whitespace-only narration is not a row", () => {
    assert.deepEqual(
      buildTrail(
        [],
        [
          { index: 0, text: "" },
          { index: 1, text: "   \n  " },
        ],
      ),
      [],
    );
  });

  test("segments ascend and narration precedes its own segment's tools", () => {
    const trail = buildTrail(
      [call("gmail.search", "succeeded", 1)],
      [
        { index: 0, text: "First I'll look" },
        { index: 1, text: "Now searching" },
      ],
    );
    assert.deepEqual(kinds(trail), ["narration", "narration", "tool"]);
    assert.equal(trail[0]?.kind === "narration" && trail[0].text, "First I'll look");
    assert.equal(trail[1]?.kind === "narration" && trail[1].text, "Now searching");
  });

  // Move fidelity — these folding rules predate the move and must not shift.
  test("consecutive identical calls fold into one row, a status change breaks it", () => {
    const folded = buildTrail(
      [
        call("gmail.search", "succeeded", 0, "a"),
        call("gmail.search", "succeeded", 0, "b"),
        call("gmail.search", "failed", 0, "c"),
      ],
      [],
    );
    assert.deepEqual(kinds(folded), ["tool", "tool"]);
    assert.equal(folded[0]?.kind === "tool" && folded[0].tools.length, 2);
    assert.equal(folded[1]?.kind === "tool" && folded[1].tools.length, 1);
  });

  test("spawn_sub_agent never folds — each spawn owns its own child trail", () => {
    const trail = buildTrail(
      [
        call(SPAWN_SUB_AGENT_TOOL, "succeeded", 0, "a"),
        call(SPAWN_SUB_AGENT_TOOL, "succeeded", 0, "b"),
      ],
      [],
    );
    assert.deepEqual(kinds(trail), ["tool", "tool"]);
  });

  test("narration between two identical calls breaks the run", () => {
    const trail = buildTrail(
      [call("gmail.search", "succeeded", 0, "a"), call("gmail.search", "succeeded", 1, "b")],
      [{ index: 1, text: "One more pass" }],
    );
    assert.deepEqual(kinds(trail), ["tool", "narration", "tool"]);
  });
});
