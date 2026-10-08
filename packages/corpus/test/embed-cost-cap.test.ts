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
 * A cost-capped document must become terminal for the sweep, not stay half-embedded.
 * A huge injected price gives a 1-token budget, so the cap fires before any Voyage call.
 * Regression: a capped doc was re-selected on every sweep.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-embedcap-";

const SOURCE = "github" as const;

/** 0.5 / 500_000 * 1e6 = 1 token, so any chunk of 2+ tokens exceeds it. */
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
