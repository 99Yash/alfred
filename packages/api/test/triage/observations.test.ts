import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  assembleObservations,
  extractContentFlags,
  extractGmailSignals,
} from "../../src/modules/triage/observations";
import type { ThreadState } from "../../src/modules/triage/thread-state";

describe("extractGmailSignals", () => {
  test("splits CATEGORY_* labels and flags IMPORTANT/STARRED/INBOX", () => {
    const signals = extractGmailSignals([
      "INBOX",
      "IMPORTANT",
      "CATEGORY_PROMOTIONS",
      "CATEGORY_UPDATES",
      "STARRED",
      "UNREAD",
    ]);
    assert.deepEqual(signals, {
      categories: ["promotions", "updates"],
      important: true,
      starred: true,
      inInbox: true,
    });
  });

  test("returns a stable empty shape for no labels", () => {
    assert.deepEqual(extractGmailSignals([]), {
      categories: [],
      important: false,
      starred: false,
      inInbox: false,
    });
  });
});

describe("extractContentFlags", () => {
  test("detects a newsletter unsubscribe footer", () => {
    const flags = extractContentFlags("Weekly digest...\nUnsubscribe from this list");
    assert.equal(flags.hasUnsubscribe, true);
  });

  test("detects currency amounts in multiple notations", () => {
    assert.equal(extractContentFlags("Total due: $1,200.00").hasCurrencyAmount, true);
    assert.equal(extractContentFlags("Amount: 500 INR").hasCurrencyAmount, true);
    // Trailing-symbol European amount — the regex's own documented example.
    assert.equal(extractContentFlags("Betrag: 1.000,00 €").hasCurrencyAmount, true);
    assert.equal(extractContentFlags("no money here").hasCurrencyAmount, false);
  });

  test("detects security/credential vocabulary", () => {
    assert.equal(
      extractContentFlags("Your API key was exposed in this commit").hasSecurityKeyword,
      true,
    );
    assert.equal(extractContentFlags("CVE-2026-1234 disclosed").hasSecurityKeyword, true);
  });

  test("detects an embedded calendar invite", () => {
    assert.equal(extractContentFlags("BEGIN:VCALENDAR\nBEGIN:VEVENT").hasCalendarInvite, true);
  });

  test("detects investor/shareholder/AGM notice language", () => {
    assert.equal(
      extractContentFlags("Notice of the 63rd Annual General Meeting for shareholders")
        .hasInvestorNotice,
      true,
    );
    assert.equal(extractContentFlags("e-voting closes via NSDL").hasInvestorNotice, true);
    assert.equal(extractContentFlags("lunch with the team tomorrow").hasInvestorNotice, false);
  });

  test("detects public-event blast language", () => {
    assert.equal(
      extractContentFlags("Join our launch webinar on Thursday").hasPublicEventLanguage,
      true,
    );
    assert.equal(extractContentFlags("Watch the WWDC26 keynote").hasPublicEventLanguage, true);
    assert.equal(
      extractContentFlags("Join us at the DevTools conference").hasPublicEventLanguage,
      true,
    );
    assert.equal(extractContentFlags("can you attend our 1:1?").hasPublicEventLanguage, false);
    // `conference call`/`conference room` are personal meetings, not blasts.
    assert.equal(
      extractContentFlags("can you do a conference call at 3?").hasPublicEventLanguage,
      false,
    );
    assert.equal(
      extractContentFlags("the team conference room is booked").hasPublicEventLanguage,
      false,
    );
  });
});

describe("assembleObservations", () => {
  const thread: ThreadState = {
    lastUserReplyAt: null,
    newestDirection: "received",
    messageCount: 1,
  };

  test("produces a stable, fully-populated observation object", () => {
    const obs = assembleObservations({
      senderContext: { effectiveAuthor: "service" },
      senderKey: "alerts@stripe.com",
      senderPrior: { categoryCounts: { payment: 4, fyi: 1 }, lastCategory: "payment" },
      persona: "work",
      thread,
      knownContact: false,
      labelIds: ["INBOX", "CATEGORY_UPDATES"],
      signalText: "Your invoice for $42.00 is ready. Unsubscribe",
    });

    assert.deepEqual(obs, {
      senderPrior: {
        key: "alerts@stripe.com",
        categoryCounts: { payment: 4, fyi: 1 },
        lastCategory: "payment",
      },
      persona: "work",
      thread,
      knownContact: false,
      gmail: { categories: ["updates"], important: false, starred: false, inInbox: true },
      content: {
        hasUnsubscribe: true,
        hasCurrencyAmount: true,
        hasSecurityKeyword: false,
        hasCalendarInvite: false,
        hasInvestorNotice: false,
        hasPublicEventLanguage: false,
      },
    });
  });

  test("falls back to empty histogram + null fields when there is no prior", () => {
    const obs = assembleObservations({
      senderContext: { effectiveAuthor: "person" },
      senderKey: null,
      senderPrior: null,
      persona: null,
      thread,
      knownContact: true,
      labelIds: [],
      signalText: "hey, quick question",
    });

    assert.deepEqual(obs.senderPrior, { key: null, categoryCounts: {}, lastCategory: null });
    assert.equal(obs.persona, null);
    assert.equal(obs.knownContact, true);
  });
});
