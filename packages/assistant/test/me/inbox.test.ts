import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isSentGmailMetadata } from "@alfred/assistant/triage/sent-mail";

describe("isSentGmailMetadata", () => {
  // A doc is sent on either the legacy or the explicit signal.
  const cases: Array<[string, Record<string, unknown> | null | undefined, boolean]> = [
    ["explicit isSent flag", { isSent: true, labelIds: [] }, true],
    ["legacy SENT label, no flag", { labelIds: ["SENT", "INBOX"] }, true],
    ["both signals present", { isSent: true, labelIds: ["SENT"] }, true],
    ["flag false but SENT label present (label wins)", { isSent: false, labelIds: ["SENT"] }, true],
    ["normal inbox row", { isSent: false, labelIds: ["INBOX", "UNREAD"] }, false],
    ["no signals at all", { labelIds: ["INBOX"] }, false],
    ["non-array labelIds, no flag", { labelIds: "SENT" }, false],
    ["missing metadata", null, false],
    ["undefined metadata", undefined, false],
  ];

  for (const [name, metadata, expected] of cases) {
    test(name, () => {
      assert.equal(isSentGmailMetadata(metadata), expected);
    });
  }

  // The SQL twins `gmailSentSql` and `notSentGmailDocumentWhere` must match; they are not tested here.
});
