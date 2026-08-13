import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { retryPending } from "@alfred/corpus";
import { closeConnections, db } from "@alfred/db";
import { documents, user } from "@alfred/db/schemas";
import { eq, inArray, like } from "drizzle-orm";
import { dbBackedSkip } from "../support/db-backed";

/**
 * DB-backed test for the sweep orchestration `@alfred/corpus` now owns
 * (`retryPending`), folded out of the api integrations worker's
 * `gmail.embed_sweep` case. It pins the two counting rules that the folded
 * loop must preserve byte-for-byte, without touching Voyage:
 *
 *   1. a dead-lettered document (`embed_failed_at` set) is NOT a candidate —
 *      `findUnembeddedDocumentIds` filters it out, so it never reaches the
 *      per-id index step;
 *   2. the `!r.empty` gate: a document that produces zero chunks embeds to
 *      `empty: true` WITHOUT a Voyage call, so it must NOT count as
 *      `succeeded`, and the empty path throws nothing (`failed` stays 0).
 *
 * `retryPending` is a global sweep keyed only on `source` (matching the
 * original worker loop, which passed no `userId`), so the test isolates on the
 * `imessage` source — no other DB-backed suite inserts an `imessage` document.
 *
 * The `succeeded` path (a real chunk+embed) needs Voyage credentials the local
 * env lacks; it is covered by the `smoke-embed` script, not here.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise. Seeds throwaway `test-retrypending-*` users and
 * cascades them away on teardown.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-retrypending-";
const SOURCE = "imessage" as const;
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

/**
 * Insert an un-embedded document whose content produces zero chunks (so the
 * index step returns `empty: true` without a Voyage call) and return its id.
 * `deadLettered` pre-sets `embed_failed_at` to exclude it from the sweep.
 */
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

    const result = await retryPending({ source: SOURCE, limit: 1000 });

    assert.equal(
      result.candidates,
      2,
      "only the two live docs are candidates (dead-lettered excluded)",
    );
    assert.equal(result.succeeded, 0, "empty docs must not count as succeeded (the !r.empty gate)");
    assert.equal(result.failed, 0, "the empty path throws nothing");

    // The two candidates were dead-lettered by the empty path, so a re-sweep
    // finds nothing — the folded loop reached them.
    assert.ok(await readFailedAt(emptyA), "candidate A dead-lettered after the sweep");
    assert.ok(await readFailedAt(emptyB), "candidate B dead-lettered after the sweep");
    assert.ok(await readFailedAt(dead), "pre-dead-lettered doc still carries its marker");

    const rerun = await retryPending({ source: SOURCE, limit: 1000 });
    assert.equal(
      rerun.candidates,
      0,
      "no candidates remain after the first sweep dead-lettered them",
    );
  });
});
