import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections } from "@alfred/db";
import { databaseEnv } from "@alfred/env/database";

import { closeReplicachePokeBridge } from "../../src/events/replicache-events";
import { isQuietMorning, scorePriorityEmailDemand } from "../../src/modules/briefing/read";
import { closeRedis } from "../../src/queue/connection";

/**
 * Pins the morning suppression invariant (#259 / ADR-0064): a cron morning
 * suppresses when nothing in the window is DEMANDING — not merely when the
 * priority buckets are empty. A normal/muted item (a resolved micro-charge, a
 * cold ask) no longer forces a send and promotes itself to the headline.
 */
describe("isQuietMorning", () => {
  const base = { emailCount: 0, activityCount: 0, meetingCount: 0 };

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
    // Legacy gather / failed day-shape: undefined demand → old behavior.
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
 * DB-backed because {@link scorePriorityEmailDemand} reads sender significance.
 * With no graph rows (a fresh user), scoring degrades to intrinsic-only — which
 * is exactly the case the gate must get right: categories at/above the demanding
 * cutoff still count, while quiet sub-cutoff items do not. Payment failures are
 * pinned demanding from subject/snippet so real billing problems are not eaten.
 */
function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}
const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";

describe("scorePriorityEmailDemand", { skip: SKIP }, () => {
  const userId = `test-briefing-suppression-${randomUUID()}`;

  after(async () => {
    await closeReplicachePokeBridge().catch(() => {});
    await closeRedis().catch(() => {});
    await closeConnections().catch(() => {});
  });

  test("empty set ⇒ no demand, muted top band", async () => {
    const demand = await scorePriorityEmailDemand(userId, []);
    assert.equal(demand.demandingCount, 0);
    assert.equal(demand.topBand, "muted");
  });

  test("a quiet day of sub-cutoff items ⇒ zero demanding (the $6.79 case suppresses)", async () => {
    const demand = await scorePriorityEmailDemand(userId, [
      {
        sender: "billing@railway.app",
        subject: "Payment receipt",
        snippet: "Your receipt for $6.79",
        category: "payment",
        occurredAtMs: 3,
      },
      {
        sender: "someone@acme.com",
        subject: "Following up",
        category: "follow_up",
        occurredAtMs: 2,
      },
      {
        sender: "digest@substack.com",
        subject: "This week in X",
        category: "fyi",
        occurredAtMs: 1,
      },
    ]);
    assert.equal(demand.demandingCount, 0);
    assert.equal(demand.topBand, "normal"); // payment/follow_up sit at normal, fyi muted
  });

  test("an actionable payment failure counts as demanding ⇒ send", async () => {
    const demand = await scorePriorityEmailDemand(userId, [
      {
        sender: "billing@railway.app",
        subject: "Payment failed - update your card",
        snippet: "We were unable to process your payment. Please update your billing card.",
        category: "payment",
        occurredAtMs: 1,
      },
    ]);
    assert.equal(demand.demandingCount, 1);
    assert.equal(demand.topBand, "demanding");
  });

  test("an unscored action_needed counts as demanding ⇒ send (errs toward sending)", async () => {
    const demand = await scorePriorityEmailDemand(userId, [
      {
        sender: "colleague@acme.com",
        subject: "Please review",
        category: "action_needed",
        occurredAtMs: 1,
      },
    ]);
    assert.equal(demand.demandingCount, 1);
    assert.equal(demand.topBand, "demanding");
  });
});
