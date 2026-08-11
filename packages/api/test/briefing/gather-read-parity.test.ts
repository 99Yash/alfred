import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { ianaTimezoneSchema, type TriageCategory } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { documents, emailTriage, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { inArray, like } from "drizzle-orm";

import { closeReplicachePokeBridge } from "@alfred/assistant/realtime";
import { gatherBriefingWithSuppressionAudit } from "@alfred/assistant/briefings/gather";
import { listEmailsSinceWatermark } from "@alfred/assistant/briefings/read";
import { rememberSenderSuppression } from "@alfred/assistant/knowledge";
import { parseLocalDateKey } from "@alfred/assistant/time";
import { closeRedis } from "@alfred/db/redis";

/**
 * Characterization of the *relationship* between the briefing's two reads of
 * the same mailbox (campaign arch-20260727 item 06). Today the pipeline pays
 * for `gatherBriefingWithSuppressionAudit`, persists its payload for the
 * surface, and then composes with an agent that re-reads the window through
 * `listEmailsSinceWatermark` and applies standing-instruction suppression a
 * second time.
 *
 * Each path is already tested alone (`suppression-gather.test.ts`,
 * `read-suppression.test.ts`). What nothing pinned is how they line up — which
 * is exactly what item 06 collapses to one read. So this file pins:
 *
 *   1. both paths drop the same instruction-suppressed sender,
 *   2. the gather's audit array reports that drop with a real fact id,
 *   3. the two paths deliberately DISAGREE on non-priority mail: `gather`
 *      carries only the six priority categories, while the agent's list
 *      carries every gmail document in the window, triaged or not.
 *
 * (3) is the load-bearing one: seeding the gather to the agent without
 * accounting for it would silently strip `fyi`/newsletter/untriaged mail out of
 * the composer's view.
 */

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-briefing-parity-";
const createdUserIds: string[] = [];

const WINDOW_START = new Date("2026-06-27T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-28T00:00:00.000Z");
/** `gather` is `>= windowStart`; the read path is `> sinceIngestedAt`. */
const READ_SINCE = new Date(WINDOW_START.getTime() - 1);
const TIMEZONE = ianaTimezoneSchema.parse("Asia/Kolkata");
const BRIEFING_DATE = parseLocalDateKey("2026-06-27");

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Briefing Parity Test", email: `${userId}@example.test` });
  return userId;
}

async function seedEmail(args: {
  userId: string;
  from: string;
  subject: string;
  /** Omit to seed an untriaged document — the left-join miss the read path tolerates. */
  category?: TriageCategory;
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
  if (args.category) {
    await db().insert(emailTriage).values({
      userId: args.userId,
      sourceThreadId: threadId,
      category: args.category,
      confidence: 0.9,
      model: "test",
      documentId: docId,
    });
  }
  return docId;
}

async function gatherFor(userId: string) {
  return gatherBriefingWithSuppressionAudit({
    userId,
    briefingDate: BRIEFING_DATE,
    slot: "morning",
    timezone: TIMEZONE,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
  });
}

async function readFor(userId: string) {
  return listEmailsSinceWatermark({
    userId,
    sinceIngestedAt: READ_SINCE,
    untilIngestedAt: WINDOW_END,
  });
}

function gatheredDocIds(gather: Awaited<ReturnType<typeof gatherFor>>["gather"]): Set<string> {
  const ids = new Set<string>();
  for (const items of Object.values(gather.email.categories)) {
    for (const item of items ?? []) ids.add(item.documentId);
  }
  return ids;
}

describe("briefing gather ↔ agent-read parity (DB-backed)", { skip: SKIP }, () => {
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

  test("both reads drop the same instruction-suppressed sender", async () => {
    const userId = await seedUser();
    const suppressedDocId = await seedEmail({
      userId,
      from: "Acme Coaching <no-reply@shapeshifter.so>",
      subject: 'Your milestone "Professional Networking" is due tomorrow',
      category: "action_needed",
    });
    const keptDocId = await seedEmail({
      userId,
      from: "Sakshi <sakshi@example.com>",
      subject: "Can you look at the import issue?",
      category: "action_needed",
    });

    // Before the instruction: both paths see both emails.
    assert.deepEqual(
      gatheredDocIds((await gatherFor(userId)).gather),
      new Set([suppressedDocId, keptDocId]),
    );
    assert.equal((await readFor(userId)).length, 2);

    const remembered = await rememberSenderSuppression({
      userId,
      senderEmail: "no-reply@shapeshifter.so",
      senderLabel: "Acme Coaching",
    });
    assert.equal(remembered.ok, true);

    // After: the same document disappears from both, and only that one.
    const { gather, suppressedByInstruction } = await gatherFor(userId);
    const readIds = new Set((await readFor(userId)).map((e) => e.documentId));

    assert.deepEqual(gatheredDocIds(gather), new Set([keptDocId]));
    assert.deepEqual(readIds, new Set([keptDocId]));

    // …and the gather side reports the drop as an auditable fact.
    assert.equal(suppressedByInstruction.length, 1);
    const audit = suppressedByInstruction[0];
    assert.equal(audit?.documentId, suppressedDocId);
    assert.equal(audit?.category, "action_needed");
    assert.equal(audit?.sender, "Acme Coaching <no-reply@shapeshifter.so>");
    assert.equal(audit?.effect, "exclude_briefing_priority");
    assert.ok(audit?.factId, "the audit entry names the standing-instruction fact");
  });

  test("the two paths disagree by design on non-priority mail", async () => {
    const userId = await seedUser();
    const priorityDocId = await seedEmail({
      userId,
      from: "Sakshi <sakshi@example.com>",
      subject: "Can you review the migration?",
      category: "action_needed",
    });
    const fyiDocId = await seedEmail({
      userId,
      from: "Substack <digest@substack.com>",
      subject: "This week in X",
      category: "fyi",
    });
    const newsletterDocId = await seedEmail({
      userId,
      from: "Some List <news@list.example>",
      subject: "Weekly roundup",
      category: "newsletter",
    });
    const untriagedDocId = await seedEmail({
      userId,
      from: "Nobody <nobody@example.com>",
      subject: "Not triaged yet",
    });

    const gatherIds = gatheredDocIds((await gatherFor(userId)).gather);
    const readIds = new Set((await readFor(userId)).map((e) => e.documentId));

    // `gather` keeps only the six priority buckets.
    assert.deepEqual(gatherIds, new Set([priorityDocId]));
    // The agent's list is every gmail document in the window, triaged or not.
    assert.deepEqual(readIds, new Set([priorityDocId, fyiDocId, newsletterDocId, untriagedDocId]));
    // The read is a strict superset today. Any reseat of the composer onto the
    // gather has to decide what happens to this difference.
    for (const id of gatherIds) assert.ok(readIds.has(id), `${id} missing from the read path`);
  });

  test("the two paths agree on window edges", async () => {
    const userId = await seedUser();
    const atStart = await seedEmail({
      userId,
      from: "Edge <edge@example.com>",
      subject: "At the window start",
      category: "action_needed",
      ingestedAt: WINDOW_START,
    });
    const atEnd = await seedEmail({
      userId,
      from: "Edge <edge@example.com>",
      subject: "At the window end",
      category: "action_needed",
      ingestedAt: WINDOW_END,
    });
    await seedEmail({
      userId,
      from: "Edge <edge@example.com>",
      subject: "Before the window",
      category: "action_needed",
      ingestedAt: new Date(WINDOW_START.getTime() - 1000),
    });
    await seedEmail({
      userId,
      from: "Edge <edge@example.com>",
      subject: "After the window",
      category: "action_needed",
      ingestedAt: new Date(WINDOW_END.getTime() + 1000),
    });

    // Both bounds are inclusive on the gather side; the read path's lower bound
    // is exclusive, which the `READ_SINCE` offset compensates for. Callers that
    // pass the previous run's watermark verbatim get a half-open window instead.
    assert.deepEqual(gatheredDocIds((await gatherFor(userId)).gather), new Set([atStart, atEnd]));
    assert.deepEqual(
      new Set((await readFor(userId)).map((e) => e.documentId)),
      new Set([atStart, atEnd]),
    );
  });

  test("suppression is a no-op audit when no instruction matches", async () => {
    const userId = await seedUser();
    const docId = await seedEmail({
      userId,
      from: "Sakshi <sakshi@example.com>",
      subject: "Can you review the migration?",
      category: "action_needed",
    });

    const { gather, suppressedByInstruction, closedLoops } = await gatherFor(userId);
    assert.deepEqual(gatheredDocIds(gather), new Set([docId]));
    assert.deepEqual(suppressedByInstruction, []);
    assert.deepEqual(closedLoops, []);
  });
});
