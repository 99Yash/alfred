import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { callerLabel } from "../../src/modules/tool-runtime";

// `callerLabel` is the single source for the caller trace tag consumed by
// execute/reject/sub-agent-await spans and the workflow dispatch-batch span, so
// a run's spans must tag the same caller identically. It projects tool-runtime's
// own `ToolCallActor["caller"]` type; this pins the format after it moved off
// the `dispatch` module (slice 05).
describe("callerLabel", () => {
  test("an absent caller labels as boss", () => {
    assert.equal(callerLabel(undefined), "boss");
  });

  test("the boss caller labels as boss", () => {
    assert.equal(callerLabel("boss"), "boss");
  });

  test("a sub-agent caller labels as sub:<id>", () => {
    assert.equal(callerLabel({ subId: "child_123" }), "sub:child_123");
  });
});
