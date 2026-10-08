import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { callerLabel } from "@alfred/assistant/tool-runtime";

// Every span of a run must tag the caller the same way.
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
