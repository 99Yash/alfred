import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isQuietMorning, scorePriorityEmailDemand } from "@alfred/assistant/briefings/read";

/** A cron morning is suppressed when nothing is demanding, even with priority items present (ADR-0064). */
describe("isQuietMorning", () => {
  const base = {
    emailCount: 0,
    activityCount: 0,
    meetingCount: 0,
    brokenConnectionCount: 0,
    activityGapCount: 0,
    officialWarningCount: 0,
  };

  test("no demanding email + no activity + no meetings ⇒ quiet (suppress)", () => {
    assert.equal(isQuietMorning({ ...base, demandingEmailCount: 0, emailCount: 5 }), true);
  });

  test("a demanding email ⇒ not quiet (send)", () => {
    assert.equal(isQuietMorning({ ...base, demandingEmailCount: 1, emailCount: 1 }), false);
  });

  test("integration activity alone keeps it awake, even with zero demanding email", () => {
    assert.equal(isQuietMorning({ ...base, demandingEmailCount: 0, activityCount: 2 }), false);
  });

  test("a calendar event alone keeps it awake", () => {
    assert.equal(isQuietMorning({ ...base, demandingEmailCount: 0, meetingCount: 1 }), false);
  });

  test("signal unavailable falls back to the raw email count — errs toward sending", () => {
    // Undefined demand keeps the old behavior.
    assert.equal(
      isQuietMorning({
        ...base,
        demandingEmailCount: undefined,
        emailCount: 3,
      }),
      false,
    );
    assert.equal(
      isQuietMorning({
        ...base,
        demandingEmailCount: undefined,
        emailCount: 0,
      }),
      true,
    );
  });
});

/**
 * Pure now: the gate reads category and the history line, not a graph read (ADR-0127).
 * A failed payment must stay demanding from its subject or snippet.
 */
describe("scorePriorityEmailDemand", () => {
  test("empty set ⇒ no demand, muted top band", () => {
    const demand = scorePriorityEmailDemand([]);
    assert.equal(demand.demandingCount, 0);
    assert.equal(demand.topBand, "muted");
  });

  test("a quiet day of sub-cutoff items ⇒ zero demanding (the $6.79 case suppresses)", () => {
    const demand = scorePriorityEmailDemand([
      {
        sender: "billing@railway.app",
        subject: "Payment receipt",
        snippet: "Your receipt for $6.79",
        category: "receipt",
        occurredAtMs: 3,
      },
      {
        sender: "digest@substack.com",
        subject: "This week in X",
        category: "news",
        occurredAtMs: 2,
      },
      {
        sender: "digest@substack.com",
        subject: "An older edition",
        category: "fyi",
        occurredAtMs: 1,
      },
    ]);

    assert.equal(demand.demandingCount, 0);
    assert.equal(demand.topBand, "normal"); // receipt sits at normal; news and fyi sit below it
  });

  test("an actionable payment failure counts as demanding ⇒ send", () => {
    const demand = scorePriorityEmailDemand([
      {
        sender: "billing@railway.app",
        subject: "Payment failed - update your card",
        snippet: "We were unable to process your payment. Please update your billing card.",
        category: "receipt",
        occurredAtMs: 1,
      },
    ]);

    assert.equal(demand.demandingCount, 1);
    assert.equal(demand.topBand, "demanding");
  });

  test("an unscored action counts as demanding ⇒ send (errs toward sending)", () => {
    const demand = scorePriorityEmailDemand([
      {
        sender: "colleague@acme.com",
        subject: "Please review",
        category: "action",
        occurredAtMs: 1,
      },
    ]);

    assert.equal(demand.demandingCount, 1);
    assert.equal(demand.topBand, "demanding");
  });
});
