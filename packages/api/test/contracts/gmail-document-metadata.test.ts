import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { gmailDocumentMetadataSchema, parseGmailDocumentMetadata } from "@alfred/contracts";

describe("GmailDocumentMetadata", () => {
  test("validates the writer projection and preserves additive metadata", () => {
    const metadata = gmailDocumentMetadataSchema.parse({
      from: "Alice <alice@example.com>",
      to: "Yash <yash@example.com>",
      cc: null,
      snippet: "A short preview",
      labelIds: ["INBOX", "UNREAD"],
      isSent: false,
      historyId: "1234",
    });

    assert.deepEqual(metadata, {
      from: "Alice <alice@example.com>",
      to: "Yash <yash@example.com>",
      cc: null,
      snippet: "A short preview",
      labelIds: ["INBOX", "UNREAD"],
      isSent: false,
      historyId: "1234",
    });
  });

  test("defaults absent fields for legacy rows", () => {
    assert.deepEqual(parseGmailDocumentMetadata({}), {});
  });

  test("defaults malformed fields independently", () => {
    assert.deepEqual(
      parseGmailDocumentMetadata({
        from: "valid@example.com",
        to: 42,
        labelIds: ["INBOX", 7],
        isSent: "false",
      }),
      {
        from: "valid@example.com",
      },
    );
  });

  test("rejects malformed known fields at the writer interface", () => {
    assert.throws(() => gmailDocumentMetadataSchema.parse({ from: 42 }));
    assert.throws(() => gmailDocumentMetadataSchema.parse({ labelIds: ["INBOX", 7] }));
  });

  test("treats a non-object persisted value as empty metadata", () => {
    assert.deepEqual(parseGmailDocumentMetadata(null), parseGmailDocumentMetadata([]));
    assert.deepEqual(parseGmailDocumentMetadata("corrupt"), parseGmailDocumentMetadata({}));
  });
});
