import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isPdfContentType } from "../src/attachments";

describe("isPdfContentType", () => {
  test("accepts canonical, legacy, and parametrized PDF content types", () => {
    assert.equal(isPdfContentType("application/pdf"), true);
    assert.equal(isPdfContentType("APPLICATION/PDF; charset=binary"), true);
    assert.equal(isPdfContentType("application/x-pdf"), true);
  });

  test("rejects non-PDF content types", () => {
    assert.equal(isPdfContentType("application/octet-stream"), false);
    assert.equal(isPdfContentType("text/plain"), false);
  });
});
