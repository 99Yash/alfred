import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { documents, emailTriage, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import type { TriageCategory } from "@alfred/contracts";
import { inArray, like } from "drizzle-orm";

import { closeReplicachePokeBridge } from "../../src/events/replicache-events";
import {
  PRIORITY_CATEGORIES,
  gatherBriefingDigest,
  type BriefingDigest,
} from "../../src/modules/briefing/gather";
import { isQuietMorning, scorePriorityEmailDemand } from "../../src/modules/briefing/read";
import { closeRedis } from "../../src/queue/connection";

/**
 * End-to-end coverage of the morning suppression chain the daily-briefing
 * workflow runs (#259 / ADR-0064): real rows → {@link gatherBriefingDigest} →
 * {@link scorePriorityEmailDemand} → {@link isQuietMorning}. The pure predicate
 * is unit-pinned in suppression.test.ts; this pins the *composition* over the DB
 * seam, which the smoke can't (it runs `reason: "forced"`, bypassing the gate).
 * Mirrors gather.ts's own `demandingEmailCount` fold, so a drift there trips here.
 */

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-briefing-suppress-gather-";
const createdUserIds: string[] = [];

const WINDOW_START = new Date("2026-06-27T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-28T00:00:00.000Z");

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Suppression Gather Test", email: `${userId}@example.test` });
  return userId;
}

async function seedEmail(args: {
  userId: string;
  from: string;
  subject: string;
  category: TriageCategory;
  ingestedAt?: Date;
}): Promise<string> {
  const threadId = `thread_${randomUUID().slice(0, 12)}`;
  const docId = `doc_${randomUUID().slice(0, 12)}`;
  const at = args.ingestedAt ?? new Date("2026-06-27T09:00:00.000Z");
  await db()
    .insert(documents)
    .values({
      id: docId,
      userId: args.userId,
      source: "gmail",
      sourceId: `msg_${randomUUID()}`,
      sourceThreadId: threadId,
      title: args.subject,
      content: "fixture body",
      contentHash: `hash_${randomUUID()}`,
      authoredAt: at,
      ingestedAt: at,
      metadata: { from: args.from, snippet: args.subject },
    });
  await db().insert(emailTriage).values({
    userId: args.userId,
    sourceThreadId: threadId,
    category: args.category,
    confidence: 0.9,
    model: "test",
    documentId: docId,
  });
  return docId;
}

/** Mirror gather.ts's fold from finalized buckets to the scorer's inputs. */
function priorityDemandItems(digest: BriefingDigest) {
  return PRIORITY_CATEGORIES.flatMap((category) =>
    digest.buckets[category].map((item) => ({
      sender: item.from,
      subject: item.subject,
      category: item.category,
      occurredAtMs: item.authoredAt?.getTime() ?? null,
    })),
  );
}

async function gateFor(userId: string): Promise<{ demandingCount: number; quiet: boolean }> {
  const digest = await gatherBriefingDigest({
    userId,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
  const demand = await scorePriorityEmailDemand(userId, priorityDemandItems(digest));
  const quiet = isQuietMorning({
    demandingEmailCount: demand.demandingCount,
    emailCount: digest.totalPriority,
    activityCount: 0,
    meetingCount: 0,
  });
  return { demandingCount: demand.demandingCount, quiet };
}

describe("morning suppression gate over gathered rows (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeReplicachePokeBridge();
    await closeRedis();
    await closeConnections();
  });

  test("a quiet day of sub-cutoff items suppresses (the $6.79 receipt case)", async () => {
    const userId = await seedUser();
    await seedEmail({
      userId,
      from: "Railway <billing@railway.app>",
      subject: "Your receipt for $6.79",
      category: "payment",
    });
    await seedEmail({
      userId,
      from: "Someone <someone@acme.com>",
      subject: "Following up on last week",
      category: "follow_up",
    });
    await seedEmail({
      userId,
      from: "Substack <digest@substack.com>",
      subject: "This week in X",
      category: "fyi",
    });

    const gate = await gateFor(userId);
    // payment/follow_up sit at `normal` (0.55), fyi at `muted` (0.2) — none clear
    // the 0.6 demanding cutoff, so the morning is genuinely quiet and suppresses.
    assert.equal(gate.demandingCount, 0);
    assert.equal(gate.quiet, true);
  });

  test("a demanding email from an unscored human wakes the morning (send)", async () => {
    const userId = await seedUser();
    await seedEmail({
      userId,
      from: "Colleague <colleague@acme.com>",
      subject: "Can you review this before EOD?",
      category: "action_needed",
    });

    const gate = await gateFor(userId);
    assert.equal(gate.demandingCount, 1);
    assert.equal(gate.quiet, false);
  });

  test(
    "KNOWN GAP (#259): a mixed day with an over-tagged bulk action_needed still sends",
    async () => {
      // Pins the current trade-off, not an endorsement: the literal #259 repro
      // day had a resolved micro-charge PLUS an over-tagged action_needed bulk
      // digest. Significance can't demote a single-sighting bulk digest
      // (recurrence needs repeats) and the sender-kind floor is awaiting_reply-only
      // today, so the day still sends. If #210's action_needed demotion later
      // pulls this to `muted`, this assertion should flip — update it consciously.
      const userId = await seedUser();
      await seedEmail({
        userId,
        from: "Railway <billing@railway.app>",
        subject: "Your receipt for $6.79",
        category: "payment",
      });
      await seedEmail({
        userId,
        from: "GitHub <notifications@github.com>",
        subject: "Weekly Dependabot digest",
        category: "action_needed",
      });

      const gate = await gateFor(userId);
      assert.equal(gate.demandingCount, 1);
      assert.equal(gate.quiet, false);
    },
  );
});
