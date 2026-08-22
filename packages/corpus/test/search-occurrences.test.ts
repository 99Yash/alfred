import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { search } from "../src/search";
import { closeConnections, db } from "@alfred/db";
import { chunks, documents, user } from "@alfred/db/schemas";
import { inArray } from "drizzle-orm";
import { dbBackedSkip } from "./support/db-backed";

/**
 * DB-backed test for #878: `search` surfaces the `metadata.references`
 * occurrences of a folded `gmail_attachment` hit. The references column is
 * unknown jsonb written by another package, so retrieval must parse it
 * defensively — a valid entry reaches the output, a malformed peer is
 * dropped, and non-attachment hits carry no occurrences at all.
 *
 * Embeddings are synthetic: the seeded chunk stores the exact vector the test
 * later passes as `queryEmbedding`, so similarity is deterministic and Voyage
 * is never called.
 */
const SKIP = dbBackedSkip("database");

const ID_PREFIX = "test-search-occ-";
const createdUserIds: string[] = [];

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Search Occ Test", email: `${userId}@example.test` });
  return userId;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const QUERY_VECTOR = Array.from({ length: 1024 }, (_, i) => ((i % 7) - 3) / 10);

async function seedAttachmentDoc(userId: string): Promise<string> {
  const [doc] = await db()
    .insert(documents)
    .values({
      userId,
      source: "gmail_attachment",
      sourceId: `${randomUUID()}:att-${randomUUID()}`,
      title: "resume.pdf",
      content: "resume text about distributed systems",
      contentHash: sha256("resume text about distributed systems"),
      authoredAt: new Date("2026-08-01T10:00:00Z"),
      metadata: {
        filename: "resume.pdf",
        mimeType: "application/pdf",
        references: [
          {
            messageId: "msg-fwd",
            attachmentId: "att-fwd",
            threadId: "thr-fwd",
            accountId: "acc-b",
            filename: "Acme_Offer_Letter.pdf",
            mimeType: "application/pdf",
            size: 2048,
            authoredAt: "2026-08-02T10:00:00.000Z",
          },
          { foo: "bar" },
          { ...validShape(), size: "big" },
        ],
      },
    })
    .returning({ id: documents.id });
  assert.ok(doc, "document seed insert returned no row");
  return doc.id;
}

function validShape(): Record<string, unknown> {
  return {
    messageId: "msg-2",
    attachmentId: "att-2",
    threadId: null,
    accountId: null,
    filename: "broken.pdf",
    mimeType: "application/pdf",
    size: 1,
    authoredAt: null,
  };
}

async function seedMailDoc(userId: string): Promise<string> {
  const [doc] = await db()
    .insert(documents)
    .values({
      userId,
      source: "gmail",
      sourceId: randomUUID(),
      title: "plain mail",
      content: "plain mail body",
      contentHash: sha256("plain mail body"),
    })
    .returning({ id: documents.id });
  assert.ok(doc, "mail document seed insert returned no row");
  return doc.id;
}

async function seedChunk(documentId: string, userId: string, content: string): Promise<void> {
  await db()
    .insert(chunks)
    .values({
      documentId,
      userId,
      position: 0,
      content,
      tokenCount: 8,
      contentHash: sha256(content),
      embedding: QUERY_VECTOR,
    });
}

describe("corpus search occurrences (DB-backed)", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("a gmail_attachment hit carries parsed occurrences; malformed entries drop; mail hits carry none", async () => {
    const userId = await seedUser();
    const mailDocId = await seedMailDoc(userId);
    const attachmentDocId = await seedAttachmentDoc(userId);
    await seedChunk(attachmentDocId, userId, "resume text about distributed systems");
    await seedChunk(mailDocId, userId, "plain mail body");

    const hits = await search({
      query: "distributed systems resume",
      queryEmbedding: QUERY_VECTOR,
      userId,
      limit: 10,
    });
    const attachmentHits = hits.filter((h) => h.documentId === attachmentDocId);
    assert.ok(attachmentHits.length > 0, "seeded attachment chunk must be retrieved");

    for (const hit of attachmentHits) {
      assert.deepEqual(hit.occurrences, [
        {
          messageId: "msg-fwd",
          attachmentId: "att-fwd",
          threadId: "thr-fwd",
          accountId: "acc-b",
          filename: "Acme_Offer_Letter.pdf",
          mimeType: "application/pdf",
          size: 2048,
          authoredAt: "2026-08-02T10:00:00.000Z",
        },
      ]);
    }

    const mailHits = hits.filter((h) => h.documentId === mailDocId);
    assert.ok(mailHits.length > 0, "seeded mail chunk must be retrieved");
    for (const hit of mailHits) {
      assert.equal(hit.occurrences, undefined, "non-attachment hits carry no occurrences");
    }
  });
});
