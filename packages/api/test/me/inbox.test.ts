import assert from "node:assert/strict";
import { describe, test } from "node:test";

// Canonical sent-mail predicate — the single JS source of truth used by the
// inbox query, triage thread-state, and the sender-prior write-back guard.
import { isSentGmailMetadata } from "../../src/modules/triage/sent-mail";

describe("isSentGmailMetadata", () => {
  // Full legacy-vs-explicit matrix: a doc is sent on EITHER signal.
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

  // NOTE: the SQL twin `gmailSentSql` / `notSentGmailDocumentWhere` (same module)
  // must filter the same rows. It is exercised by the live inbox query, not unit-
  // tested here (no DB harness). Both forms now live in one module and check both
  // signals, so they can no longer drift the way the prior three copies did.
});
