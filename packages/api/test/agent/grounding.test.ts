import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatDateGrounding, formatRuntimeTimeGrounding } from "../../src/modules/agent/grounding";

describe("formatDateGrounding", () => {
  test("keeps the cached system grounding date-only", () => {
    assert.equal(
      formatDateGrounding("Asia/Calcutta", new Date("2026-07-14T02:50:11.451Z")),
      "Tuesday, 14 July 2026 (2026-07-14), timezone Asia/Calcutta",
    );
  });

  test("formats an exact UTC and local run-time anchor for ephemeral context", () => {
    assert.equal(
      formatRuntimeTimeGrounding("Asia/Calcutta", new Date("2026-07-14T02:50:11.451Z")),
      "<runtime_context>Current time: 2026-07-14T02:50:11.451Z (2026-07-14T08:20:11 in Asia/Calcutta).</runtime_context>",
    );
  });
});
