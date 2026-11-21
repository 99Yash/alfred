import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatDateGrounding } from "@alfred/assistant/execution/grounding";

describe("formatDateGrounding", () => {
  test("keeps the cached system grounding date-only", () => {
    assert.equal(
      formatDateGrounding("Asia/Calcutta", new Date("2026-07-14T02:50:11.451Z")),
      "Tuesday, 14 July 2026 (2026-07-14), timezone Asia/Calcutta",
    );
  });
});
