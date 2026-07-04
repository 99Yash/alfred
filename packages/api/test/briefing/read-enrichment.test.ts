import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import { documents, emailTriage, user } from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { inArray, like } from "drizzle-orm";

import { closeReplicachePokeBridge } from "../../src/events/replicache-events";
import { listEmailsSinceWatermark } from "../../src/modules/briefing/read";
import { closeRedis } from "../../src/queue/connection";

function hasDatabaseUrl(): boolean {
  try {
    return Boolean(databaseEnv().DATABASE_URL);
  } catch {
    return false;
  }
}

const SKIP = hasDatabaseUrl() ? false : "DATABASE_URL not set — skipping DB-backed test";
const ID_PREFIX = "test-briefing-read-enrich-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Briefing Enrich Test", email: `${userId}@example.test` });
  return userId;
}

async function seedEmail(args: {
  userId: string;
  subject: string;
  authoredAt: Date;
  ingestedAt: Date;
  /** Gmail internalDate, i.e. actual inbox receipt time. Defaults to authoredAt. */
  receivedAt?: Date;
  /** Omit to simulate a row ingested before labelIds were captured. */
  labelIds?: string[];
}): Promise<string> {
  const threadId = `thread_${randomUUID().slice(0, 12)}`;
  const docId = `doc_${randomUUID().slice(0, 12)}`;
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
      authoredAt: args.authoredAt,
      ingestedAt: args.ingestedAt,
      raw: {
        id: `msg_raw_${randomUUID()}`,
        threadId,
        internalDate: String((args.receivedAt ?? args.authoredAt).getTime()),
      },
      metadata: {
        from: "Sakshi <sakshi@example.com>",
        snippet: args.subject,
        internalDate: String((args.receivedAt ?? args.authoredAt).getTime()),
        ...(args.labelIds ? { labelIds: args.labelIds } : {}),
      },
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

describe("briefing feed receipt-time + seen-state enrichment (DB-backed)", { skip: SKIP }, () => {
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

  test("unread reflects the UNREAD label as a tri-state, and receivedAtLocal renders in tz", async () => {
    const userId = await seedUser();
    // The #284 evidence: 21:40 UTC = 03:10 the next morning in India.
    const authored = new Date("2026-06-26T04:00:00.000Z");
    const overnight = new Date("2026-06-26T21:40:00.000Z");

    const unreadDoc = await seedEmail({
      userId,
      subject: "Fresh overnight ask",
      authoredAt: authored,
      receivedAt: overnight,
      ingestedAt: new Date("2026-06-26T21:41:00.000Z"),
      labelIds: ["INBOX", "UNREAD"],
    });
    const readDoc = await seedEmail({
      userId,
      subject: "Already opened",
      authoredAt: authored,
      receivedAt: overnight,
      ingestedAt: new Date("2026-06-26T21:42:00.000Z"),
      labelIds: ["INBOX"],
    });
    const readEmptyLabelsDoc = await seedEmail({
      userId,
      subject: "Already opened with no labels",
      authoredAt: authored,
      receivedAt: overnight,
      ingestedAt: new Date("2026-06-26T21:42:30.000Z"),
      labelIds: [],
    });
    const unknownDoc = await seedEmail({
      userId,
      subject: "No label signal",
      authoredAt: authored,
      receivedAt: overnight,
      ingestedAt: new Date("2026-06-26T21:43:00.000Z"),
    });

    const rows = await listEmailsSinceWatermark({
      userId,
      sinceIngestedAt: null,
      untilIngestedAt: new Date("2026-06-26T23:00:00.000Z"),
      timezone: "Asia/Kolkata",
    });
    const byId = new Map(rows.map((r) => [r.documentId, r]));

    assert.equal(byId.get(unreadDoc)?.unread, true);
    assert.equal(byId.get(readDoc)?.unread, false);
    assert.equal(byId.get(readEmptyLabelsDoc)?.unread, false);
    assert.equal(byId.get(unknownDoc)?.unread, null);

    // Every item renders Gmail internalDate (receipt time), not the RFC Date header.
    const local = byId.get(unreadDoc)?.receivedAtLocal;
    assert.ok(local?.includes("3:10 AM"), `expected 3:10 AM local, got: ${local}`);
  });

  test("receivedAtLocal is null when no timezone is supplied", async () => {
    const userId = await seedUser();
    await seedEmail({
      userId,
      subject: "No tz passed",
      authoredAt: new Date("2026-06-26T21:40:00.000Z"),
      receivedAt: new Date("2026-06-26T21:40:00.000Z"),
      ingestedAt: new Date("2026-06-26T21:41:00.000Z"),
      labelIds: ["INBOX", "UNREAD"],
    });

    const rows = await listEmailsSinceWatermark({
      userId,
      sinceIngestedAt: null,
      untilIngestedAt: new Date("2026-06-26T23:00:00.000Z"),
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.receivedAtLocal, null);
    // Read-state still resolves without a timezone.
    assert.equal(rows[0]?.unread, true);
  });
});
