import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isSentGmailMetadata, mayBeUnflaggedSentMail } from "../../src/modules/triage/sent-mail";

/**
 * The classify-time sent guard (#306) used to do a live Gmail `getMessage` on
 * every document whose stored metadata wasn't already `SENT` — which for
 * received mail is every document, putting a network round trip in front of
 * every classify (#439).
 *
 * `mayBeUnflaggedSentMail` is the disproof that lets most of those be skipped:
 * every message the #306 gap can mis-flag is one the *user sent*, so a `From`
 * that is demonstrably a third party can never become the user's sent mail. The
 * two halves both matter — skipping too much silently reopens #306, skipping too
 * little gives the latency back — so both are pinned here.
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
    // The reason this predicate takes `identity.mailboxAddress` and not
    // `identity.email`: the latter falls back to the user's primary app email
    // when a credential carries no `accountLabel`. Feed it that fallback and a
    // secondary account's genuine sent mail reads as third-party — the #306
    // guard would go silently off for every message in that mailbox.
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
    // Accepted, not fixed — see `mayBeUnflaggedSentMail`. Pinned so the day
    // alias sending becomes a feature, this test is what fails first.
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: "Yash <yash@alias.example>", mailboxAddress: ACCOUNT }),
      false,
    );
  });

  test("the predicate is only consulted for stored-not-sent docs", () => {
    // Guards the ordering in `sentDocumentStatusAtClassifyTime`: an already-SENT
    // document short-circuits on stored metadata and never reaches the gate, so
    // the gate never has to reason about the user's own outbound mail.
    assert.equal(isSentGmailMetadata({ labelIds: ["SENT"] }), true);
    assert.equal(isSentGmailMetadata({ isSent: true }), true);
    assert.equal(isSentGmailMetadata({ labelIds: ["INBOX"] }), false);
  });
});
