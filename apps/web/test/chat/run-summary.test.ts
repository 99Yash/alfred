import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runSummary } from "../../src/routes/-chat/run-summary";
import type { ToolCallView } from "../../src/routes/-chat/tool-call-presentation";

const call = (
  toolName: string,
  status: ToolCallView["status"],
  toolCallId = toolName,
): ToolCallView => ({ toolCallId, toolName, status });

describe("runSummary", () => {
  test("describes what landed, not what was attempted", () => {
    assert.equal(runSummary([call("google_calendar.list_events", "succeeded")]).length > 0, true);
    // The same call, failed, must not be narrated as done work — the trail's
    // own failure marker is what says a step went wrong.
    assert.notEqual(
      runSummary([call("google_calendar.list_events", "failed")]),
      runSummary([call("google_calendar.list_events", "succeeded")]),
    );
  });

  test("a run where everything failed says so instead of claiming work", () => {
    assert.equal(
      runSummary([call("gmail.search", "failed"), call("github.search", "failed", "c2")]),
      "Couldn't finish that",
    );
  });

  test("a failed step does not inflate the count of a mixed run", () => {
    const mixed = [
      call("gmail.search", "succeeded"),
      call("github.search", "failed", "c2"),
      call("linear.search", "failed", "c3"),
    ];
    // One source landed, so this reads as that one read — not as the
    // "Searched multiple sources" a three-call tally would produce.
    assert.equal(mixed.filter((t) => t.status === "succeeded").length, 1);
    assert.notEqual(runSummary(mixed), "Searched multiple sources");
    assert.equal(runSummary(mixed), runSummary([call("gmail.search", "succeeded")]));
  });

  test("a still-running step is not counted as landed", () => {
    assert.equal(runSummary([call("gmail.search", "started")]), "Worked on it");
  });
});
