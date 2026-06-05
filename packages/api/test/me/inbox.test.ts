import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isSentGmailMetadata } from "../../src/modules/me/routes";

describe("isSentGmailMetadata", () => {
  test("detects the explicit sent metadata bit", () => {
    assert.equal(isSentGmailMetadata({ isSent: true, labelIds: [] }), true);
  });

  test("detects legacy sent rows from Gmail labelIds", () => {
    assert.equal(isSentGmailMetadata({ labelIds: ["SENT"] }), true);
  });

  test("does not treat normal inbox rows as sent", () => {
    assert.equal(isSentGmailMetadata({ isSent: false, labelIds: ["INBOX", "UNREAD"] }), false);
  });

  test("handles missing metadata defensively", () => {
    assert.equal(isSentGmailMetadata(null), false);
  });
});
