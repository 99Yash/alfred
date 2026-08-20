import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyUpload, isChatUploadAllowed, isPdfContentType } from "../src/attachments";

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

describe("isChatUploadAllowed", () => {
  test("accepts the chat formats implemented end to end", () => {
    assert.equal(isChatUploadAllowed("image/jpeg"), true);
    assert.equal(isChatUploadAllowed("IMAGE/PNG; charset=binary"), true);
    assert.equal(isChatUploadAllowed("application/pdf"), true);
    assert.equal(classifyUpload("application/pdf")?.chatAllowed, true);
    assert.equal(classifyUpload("application/pdf")?.contentFamily, "pdf");
  });

  test("keeps policy-listed formats gated until their degrade path exists", () => {
    assert.equal(isChatUploadAllowed("image/gif"), false);
    assert.equal(isChatUploadAllowed("audio/mpeg"), false);
    assert.equal(classifyUpload("audio/mpeg")?.chatAllowed, false);
    assert.equal(
      isChatUploadAllowed(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
      false,
    );
    assert.equal(isChatUploadAllowed("application/x-pdf"), false);
  });
});
