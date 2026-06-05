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
