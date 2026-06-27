import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { documents, emailTriage, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { inArray, like } from "drizzle-orm";

import { closeReplicachePokeBridge } from "../../src/events/replicache-events";
import { listEmailsSinceWatermark } from "../../src/modules/briefing/read";
import { rememberSenderSuppression } from "../../src/modules/memory/standing-instructions";
import { closeRedis } from "../../src/queue/connection";

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-briefing-read-suppress-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Briefing Read Test", email: `${userId}@example.test` });
  return userId;
}

async function seedEmail(args: {
  userId: string;
  from: string;
  subject: string;
  ingestedAt?: Date;
}): Promise<string> {
  const threadId = `thread_${randomUUID().slice(0, 12)}`;
  const docId = `doc_${randomUUID().slice(0, 12)}`;
  const now = args.ingestedAt ?? new Date();
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
      authoredAt: now,
      ingestedAt: now,
      metadata: { from: args.from, snippet: args.subject },
    });
  await db().insert(emailTriage).values({
    userId: args.userId,
    sourceThreadId: threadId,
    category: "action_needed",
    confidence: 0.9,
    model: "test",
    documentId: docId,
  });
  return docId;
}

describe("briefing read-side standing-instruction suppression (DB-backed)", { skip: SKIP }, () => {
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

  test("a suppressed sender is dropped from the briefing agent's email list", async () => {
    const userId = await seedUser();
    const keepIngestedAt = new Date("2026-06-27T09:00:00.000Z");
    const suppressedIngestedAt = new Date("2026-06-27T09:01:00.000Z");
    await seedEmail({
      userId,
      from: "Acme Coaching <no-reply@shapeshifter.so>",
      subject: 'Your milestone "Professional Networking" is due tomorrow',
      ingestedAt: suppressedIngestedAt,
    });
    const keepDocId = await seedEmail({
      userId,
      from: "Sakshi <sakshi@example.com>",
      subject: "Can you look at the import issue?",
      ingestedAt: keepIngestedAt,
    });

    const until = new Date(Date.now() + 60_000);

    // Before suppression: both emails are visible to the briefing agent.
    const before = await listEmailsSinceWatermark({
      userId,
      sinceIngestedAt: null,
      untilIngestedAt: until,
    });
    assert.equal(before.length, 2);

    // The user tells Alfred to stop surfacing the coaching sender.
    const remembered = await rememberSenderSuppression({
      userId,
      senderEmail: "no-reply@shapeshifter.so",
      senderLabel: "Acme Coaching",
    });
    assert.equal(remembered.ok, true);

    // After: the suppressed sender is gone; the real ask remains.
    const after = await listEmailsSinceWatermark({
      userId,
      sinceIngestedAt: null,
      untilIngestedAt: until,
    });
    assert.equal(after.length, 1);
    assert.equal(after[0]?.documentId, keepDocId);
    assert.ok(!after.some((e) => e.from?.includes("shapeshifter")));

    // Limit is applied after a small metadata-only over-fetch, so the newest
    // suppressed row does not under-fill the caller's requested window.
    const limited = await listEmailsSinceWatermark({
      userId,
      sinceIngestedAt: null,
      untilIngestedAt: until,
      limit: 1,
    });
    assert.equal(limited.length, 1);
    assert.equal(limited[0]?.documentId, keepDocId);
  });

  test("suppressed newest rows do not under-fill a limited email window", async () => {
    const userId = await seedUser();
    const keepDocId = await seedEmail({
      userId,
      from: "Sakshi <sakshi@example.com>",
      subject: "The real ask behind the noisy sender",
      ingestedAt: new Date("2026-06-27T09:00:00.000Z"),
    });
    await seedEmail({
      userId,
      from: "Acme Coaching <no-reply@shapeshifter.so>",
      subject: "Noisy nudge 1",
      ingestedAt: new Date("2026-06-27T09:01:00.000Z"),
    });
    await seedEmail({
      userId,
      from: "Acme Coaching <no-reply@shapeshifter.so>",
      subject: "Noisy nudge 2",
      ingestedAt: new Date("2026-06-27T09:02:00.000Z"),
    });
    await seedEmail({
      userId,
      from: "Acme Coaching <no-reply@shapeshifter.so>",
      subject: "Noisy nudge 3",
      ingestedAt: new Date("2026-06-27T09:03:00.000Z"),
    });

    const remembered = await rememberSenderSuppression({
      userId,
      senderEmail: "no-reply@shapeshifter.so",
      senderLabel: "Acme Coaching",
    });
    assert.equal(remembered.ok, true);

    const rows = await listEmailsSinceWatermark({
      userId,
      sinceIngestedAt: null,
      untilIngestedAt: new Date("2026-06-27T10:00:00.000Z"),
      limit: 1,
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.documentId, keepDocId);
  });
});
