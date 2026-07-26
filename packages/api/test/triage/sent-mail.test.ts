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
      mayBeUnflaggedSentMail({ fromHeader: "Stripe <receipts@stripe.com>", accountEmail: ACCOUNT }),
      false,
    );
  });

  test("the #306 case stays guarded: From is the account itself", () => {
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: `Yash <${ACCOUNT}>`, accountEmail: ACCOUNT }),
      true,
    );
  });

  test("self-match ignores display name and case", () => {
    assert.equal(
      mayBeUnflaggedSentMail({
        fromHeader: `"Yash G. Kar" <YASH@Oliv.ai>`,
        accountEmail: "Yash@OLIV.ai",
      }),
      true,
    );
  });

  test("a bare address (no display name) still matches the account", () => {
    assert.equal(mayBeUnflaggedSentMail({ fromHeader: ACCOUNT, accountEmail: ACCOUNT }), true);
  });

  test("a missing From can't be disproved — stay guarded", () => {
    assert.equal(mayBeUnflaggedSentMail({ fromHeader: null, accountEmail: ACCOUNT }), true);
  });

  test("an unparseable From can't be disproved — stay guarded", () => {
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: "Mailer Daemon", accountEmail: ACCOUNT }),
      true,
    );
  });

  test("an unresolvable account address can't be compared against — stay guarded", () => {
    for (const accountEmail of [null, "", "not-an-address"]) {
      assert.equal(
        mayBeUnflaggedSentMail({ fromHeader: "someone@example.com", accountEmail }),
        true,
        `accountEmail=${JSON.stringify(accountEmail)}`,
      );
    }
  });

  test("the documented residual gap: a send-as alias skips the live check", () => {
    // Accepted, not fixed — see `mayBeUnflaggedSentMail`. Pinned so the day
    // alias sending becomes a feature, this test is what fails first.
    assert.equal(
      mayBeUnflaggedSentMail({ fromHeader: "Yash <yash@alias.example>", accountEmail: ACCOUNT }),
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
