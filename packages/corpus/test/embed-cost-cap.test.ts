import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";

import { findUnembeddedDocumentIds, indexDocument } from "../src/index";
import { closeConnections, db } from "@alfred/db";
import { chunks, documents, user } from "@alfred/db/schemas";
import { and, eq, inArray, like } from "drizzle-orm";
import { dbBackedSkip } from "./support/db-backed";
import { sha256 } from "../src/hash";

/**
 * DB-backed test for the cost-cap truncation policy (architecture review
 * candidate 2): the $0.50 cap governs ONE `indexDocument` call, and a
 * truncation marks the document terminal for the sweep instead of leaving it
 * silently half-embedded.
 *
 * The injected `pricePerMtokUsd` is what makes this reachable without Voyage:
 * a price of 500_000 $/Mtok derives a 1-token budget (`maxTokensForPrice`),
 * so the first chunk alone exceeds the cap and `indexDocument` returns
 * `truncated: true` with zero chunks written — before any provider call.
 *
 * Pins three properties of the zero-kept path:
 *
 *   1. the result reports `truncated: true`, `chunksWritten: 0`, and
 *      `empty: false` (the doc HAS embeddable content — it was capped);
 *   2. the document row carries the terminal marker (`embed_failed_at` set,
 *      `last_embed_error` naming the cost cap) so the sweep drops it;
 *   3. `findUnembeddedDocumentIds` no longer selects it — the pre-fix
 *      behavior re-selected such a doc on every sweep forever.
 *
 * Opt-in: runs only when `DATABASE_URL` points at a reachable migrated
 * Postgres; skipped otherwise. Isolates on throwaway `test-embedcap-*` users
 * writing `drive` documents (no other suite seeds that source) and cascades
 * them away on teardown.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-embedcap-";
const SOURCE = "drive" as const;
/** 0.5 / 500_000 * 1e6 = 1 → any chunk of ≥2 tokens exceeds the budget. */
const ABSURD_PRICE_PER_MTOK = 500_000;
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Test User", email: `${userId}@example.test` });
  return userId;
}

async function seedDocument(userId: string): Promise<string> {
  const content = Array.from(
    { length: 8 },
    (_, i) => `Paragraph ${i} with enough words to cost several tokens.`,
  ).join("\n\n");
  const [row] = await db()
    .insert(documents)
    .values({
      userId,
      source: SOURCE,
      sourceId: randomUUID(),
      content,
      contentHash: sha256(content),
    })
    .returning({ id: documents.id });
  assert.ok(row, "seed insert returned no row");
  return row.id;
}

describe("corpus embed cost cap (DB-backed)", { skip: SKIP }, () => {
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

  test("a fully-capped doc is marked terminal and leaves the sweep candidate set", async () => {
    const userId = await seedUser();
    const docId = await seedDocument(userId);

    const result = await indexDocument({
      documentId: docId,
      pricePerMtokUsd: ABSURD_PRICE_PER_MTOK,
    });

    assert.equal(result.truncated, true, "the 1-token budget must truncate");
    assert.equal(result.chunksWritten, 0, "nothing fits the budget, so nothing is written");
    assert.equal(result.empty, false, "the doc has content — it was capped, not empty");

    const [row] = await db()
      .select({
        embedFailedAt: documents.embedFailedAt,
        lastEmbedError: documents.lastEmbedError,
      })
      .from(documents)
      .where(eq(documents.id, docId));
    assert.ok(row, "document row disappeared");
    assert.ok(row.embedFailedAt, "truncation stamps the terminal marker for the sweep");
    assert.match(row.lastEmbedError ?? "", /cost cap/, "lastEmbedError names the cost cap");

    const written = await db()
      .select({ one: chunks.position })
      .from(chunks)
      .where(and(eq(chunks.documentId, docId)));
    assert.equal(written.length, 0, "no chunk rows exist for a zero-kept truncation");

    const pending = await findUnembeddedDocumentIds({ userId, limit: 1000 });
    assert.ok(
      !pending.includes(docId),
      "the capped doc must not be re-selected by the sweep forever",
    );
  });
});
