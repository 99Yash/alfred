import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { retryPending } from "../src/index";
import { closeConnections, db } from "@alfred/db";
import { documents, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";
import { dbBackedSkip } from "./support/db-backed";

/**
 * Pins the `retryPending` counts without Voyage: dead-lettered docs are not candidates,
 * and a zero-chunk doc is not `succeeded` and does not throw.
 * Pass the seeded `userId`: a `source` filter does not isolate, since every source has a live writer.
 * The `succeeded` path needs Voyage; `smoke-embed` covers it.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-retrypending-";

const SOURCE = "sentry" as const;

const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });

  return userId;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** A zero-chunk document, so indexing makes no Voyage call. `deadLettered` excludes it from the sweep. */
async function seedEmptyDocument(userId: string, deadLettered = false): Promise<string> {
  const content = "";

  const [row] = await db()
    .insert(documents)
    .values({
      userId,
      source: SOURCE,
      sourceId: randomUUID(),
      content,
      contentHash: sha256(content),
      ...(deadLettered ? { embedFailedAt: new Date() } : {}),
    })
    .returning({ id: documents.id });

  assert.ok(row, "seed insert returned no row");

  return row.id;
}

async function readFailedAt(docId: string): Promise<Date | null> {
  const [row] = await db()
    .select({ embedFailedAt: documents.embedFailedAt })
    .from(documents)
    .where(eq(documents.id, docId));

  assert.ok(row, "document row disappeared");

  return row.embedFailedAt;
}

describe("corpus retryPending sweep (DB-backed)", { skip: SKIP }, () => {
  before(async () => {
    await db()
      .delete(user)
      .where(like(user.id, `${ID_PREFIX}%`));
  });

  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }

    await closeConnections();
  });

  test("counts candidates, excludes dead-lettered rows, and never counts empty docs as succeeded", async () => {
    const userId = await seedUser();
    const emptyA = await seedEmptyDocument(userId);
    const emptyB = await seedEmptyDocument(userId);
    const dead = await seedEmptyDocument(userId, true);

    const result = await retryPending({ userId, source: SOURCE, limit: 1000 });

    assert.equal(
      result.candidates,
      2,
      "only the two live docs are candidates (dead-lettered excluded)",
    );
    assert.equal(result.succeeded, 0, "empty docs must not count as succeeded (the !r.empty gate)");
    assert.equal(result.failed, 0, "the empty path throws nothing");

    // The empty path dead-letters both candidates, which proves the sweep reached them.
    assert.ok(await readFailedAt(emptyA), "candidate A dead-lettered after the sweep");
    assert.ok(await readFailedAt(emptyB), "candidate B dead-lettered after the sweep");
    assert.ok(await readFailedAt(dead), "pre-dead-lettered doc still carries its marker");

    const rerun = await retryPending({ userId, source: SOURCE, limit: 1000 });
    assert.equal(
      rerun.candidates,
      0,
      "no candidates remain after the first sweep dead-lettered them",
    );
  });
});
