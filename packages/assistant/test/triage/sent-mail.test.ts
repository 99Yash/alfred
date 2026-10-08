import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isSentGmailMetadata, mayBeUnflaggedSentMail } from "@alfred/assistant/triage/sent-mail";

/**
 * `mayBeUnflaggedSentMail` lets classify skip the live Gmail sent check.
 * A third-party `From` can never be the user's sent mail. Skipping too much
 * mis-flags sent mail (#306); skipping too little brings back the latency (#439).
 */

const ACCOUNT = "yash@oliv.ai";

describe("mayBeUnflaggedSentMail", () => {
  test("a third-party sender is provably not the user's own mail — no live check", () => {
    assert.equal(
      mayBeUnflaggedSentMail({
        fromHeader: "Stripe <receipts@stripe.com>",
        mailboxAddress: ACCOUNT,
      }),
      false,
    );
  });

  test("the #306 case stays guarded: From is the account itself", () => {
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: `Yash <${ACCOUNT}>`, mailboxAddress: ACCOUNT }),
      true,
    );
  });

  test("self-match ignores display name and case", () => {
    assert.equal(
      mayBeUnflaggedSentMail({
        fromHeader: `"Yash G. Kar" <YASH@Oliv.ai>`,
        mailboxAddress: "Yash@OLIV.ai",
      }),
      true,
    );
  });

  test("a bare address (no display name) still matches the account", () => {
    assert.equal(mayBeUnflaggedSentMail({ fromHeader: ACCOUNT, mailboxAddress: ACCOUNT }), true);
  });

  test("a missing From can't be disproved — stay guarded", () => {
    assert.equal(mayBeUnflaggedSentMail({ fromHeader: null, mailboxAddress: ACCOUNT }), true);
  });

  test("an unparseable From can't be disproved — stay guarded", () => {
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: "Mailer Daemon", mailboxAddress: ACCOUNT }),
      true,
    );
  });

  test("an unresolvable mailbox address can't be compared against — stay guarded", () => {
    for (const mailboxAddress of [null, "", "not-an-address"]) {
      assert.equal(
        mayBeUnflaggedSentMail({ fromHeader: "someone@example.com", mailboxAddress }),
        true,
        `mailboxAddress=${JSON.stringify(mailboxAddress)}`,
      );
    }
  });

  test("a second mailbox's own address is what it's compared against, not the primary", () => {
    // Use `mailboxAddress`, not `email`: `email` can fall back to the primary app email,
    // and then a secondary mailbox's sent mail reads as third-party.
    const SECONDARY = "yash@personal.example";

    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: `Yash <${SECONDARY}>`, mailboxAddress: SECONDARY }),
      true,
      "the mailbox's own address keeps the guard on",
    );
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: `Yash <${SECONDARY}>`, mailboxAddress: ACCOUNT }),
      false,
      "the primary-email fallback is what silently disarms it — hence the separate field",
    );
    // Unknown is the safe input: no address, no disproof, live check runs.
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: `Yash <${SECONDARY}>`, mailboxAddress: null }),
      true,
    );
  });

  test("the documented residual gap: a send-as alias skips the live check", () => {
    // Accepted gap; see `mayBeUnflaggedSentMail`. This fails first if alias sending ships.
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: "Yash <yash@alias.example>", mailboxAddress: ACCOUNT }),
      false,
    );
  });

  test("the predicate is only consulted for stored-not-sent docs", () => {
    // `sentDocumentStatusAtClassifyTime` returns early for a stored SENT doc, so the gate never sees it.
    assert.equal(isSentGmailMetadata({ labelIds: ["SENT"] }), true);
    assert.equal(isSentGmailMetadata({ isSent: true }), true);
    assert.equal(isSentGmailMetadata({ labelIds: ["INBOX"] }), false);
  });
});
