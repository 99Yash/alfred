import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeConnections, db } from "@alfred/db";
import { documents, user } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import {
  appendContentReference,
  ingestGmailMediaAttachments,
} from "../src/connections/ingestion/gmail-media";
import type { Extraction } from "@alfred/extraction";
import type { GmailMessage } from "@alfred/integrations/google";
import { dbBackedSkip } from "./support/db-backed";

const SKIP = dbBackedSkip("database");
const ID_PREFIX = "test-gmail-att-";
const createdUserIds: string[] = [];

/** Test-only media door: supports PDF only, returns the given extract result. */
function pdfOnlyMedia(
  extract: Extraction["extract"],
): Pick<Extraction, "extract" | "isSupported" | "wouldExceed"> {
  return {
    isSupported: (mime) => mime === "application/pdf",
    wouldExceed: () => false,
    extract,
  };
}

after(async () => {
  if (createdUserIds.length) {
    await db().delete(user).where(inArray(user.id, createdUserIds));
  }
  await closeConnections();
});

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Gmail Att Test", email: `${userId}@example.test` });
  return userId;
}

function makeMessage(args: {
  id: string;
  threadId: string;
  attachmentId: string;
  filename: string;
  mimeType?: string;
  size?: number;
}): GmailMessage {
  // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test factory builds a minimal GmailMessage shape; the gmail parser only reads id/threadId/labelIds/payload.
  return {
    id: args.id,
    threadId: args.threadId,
    labelIds: [],
    snippet: "test snippet",
    historyId: "1000",
    internalDate: String(Date.now()),
    payload: {
      headers: [{ name: "Subject", value: "Test mail" }],
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("hello").toString("base64url") } },
        {
          partId: "1",
          mimeType: args.mimeType ?? "application/pdf",
          filename: args.filename,
          body: { attachmentId: args.attachmentId, size: args.size ?? 1024 },
        },
      ],
    },
    sizeEstimate: 2048,
  } as unknown as GmailMessage;
}

describe("gmail attachment ingestion — DB-backed", { skip: SKIP }, () => {
  test("ingest creates gmail_attachment document with page offsets and isolates from gmail source", async () => {
    const userId = await seedUser();
    const accountId = `acc-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const attachmentId = `att-${randomUUID()}`;
    const message = makeMessage({
      id: messageId,
      threadId: `thr-${randomUUID()}`,
      attachmentId,
      filename: "contract.pdf",
    });

    const bytes = new Uint8Array(Buffer.from("%PDF-1.4 fake bytes"));
    let indexCalls = 0;
    const result = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message,
      accessToken: "fake-token",
      authoredAt: new Date(),
      deps: {
        getAttachment: async () => ({ bytes, size: bytes.byteLength }),
        media: pdfOnlyMedia(async () => ({
          kind: "extracted" as const,
          format: "pdf" as const,
          content: "page one text\n\npage two text",
          pages: [
            { page: 1, start: 0, end: 13 },
            { page: 2, start: 15, end: 28 },
          ],
        })),
        indexDocument: async () => {
          indexCalls++;
          return { documentId: "fake", chunksWritten: 1, chunksSkipped: 0, empty: false };
        },
      },
    });

    assert.equal(result.ingested, 1);
    assert.equal(result.attempted, 1);
    assert.equal(indexCalls, 1);

    const rows = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    assert.equal(rows.length, 1);
    const doc = rows[0]!;
    assert.equal(doc.sourceId, `${messageId}:${attachmentId}`);
    assert.equal(doc.title, "contract.pdf");
    assert.equal(doc.content, "page one text\n\npage two text");
    // eslint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: documents.metadata is jsonb unknown; test narrows to the gmail_attachment shape we just wrote.
    const meta = doc.metadata as {
      pages?: { page: number; start: number; end: number }[];
      filename: string;
    };
    assert.ok(Array.isArray(meta.pages));
    assert.equal(meta.pages!.length, 2);
    assert.deepEqual(meta.pages![0], { page: 1, start: 0, end: 13 });
    assert.deepEqual(meta.pages![1], { page: 2, start: 15, end: 28 });
    assert.equal(meta.filename, "contract.pdf");

    // Isolation: a query that filters source=gmail (the inbox reader contract) must not see the attachment row.
    const gmailRows = await db()
      .select({ id: documents.id, source: documents.source })
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail")));
    assert.equal(
      gmailRows.length,
      0,
      "inbox reader filter source=gmail must not return gmail_attachment",
    );

    // Insert a normal gmail document and prove the two sources stay disjoint.
    await db()
      .insert(documents)
      .values({
        userId,
        source: "gmail",
        sourceId: `gmail-${randomUUID()}`,
        title: "mail subject",
        content: "mail body",
        contentHash: randomUUID(),
        metadata: {},
      });
    const allRows = await db()
      .select({ source: documents.source })
      .from(documents)
      .where(eq(documents.userId, userId));
    assert.equal(allRows.filter((r) => r.source === "gmail").length, 1);
    assert.equal(allRows.filter((r) => r.source === "gmail_attachment").length, 1);
  });

  test("re-ingest of an existing attachment dedups without fetch, extract, or embed", async () => {
    const userId = await seedUser();
    const accountId = `acc-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const attachmentId = `att-${randomUUID()}`;
    const message = makeMessage({
      id: messageId,
      threadId: `thr-${randomUUID()}`,
      attachmentId,
      filename: "invoice.pdf",
    });
    let getAttachmentCalls = 0;
    let indexCalls = 0;
    const deps = {
      getAttachment: async () => {
        getAttachmentCalls++;
        return { bytes: new Uint8Array(Buffer.from("%PDF-1.4")), size: 9 };
      },
      media: pdfOnlyMedia(async () => ({
        kind: "extracted" as const,
        format: "pdf" as const,
        content: "version one",
        pages: [{ page: 1, start: 0, end: 11 }],
      })),
      indexDocument: async () => {
        indexCalls++;
        return { documentId: "fake", chunksWritten: 1, chunksSkipped: 0, empty: false };
      },
    };

    const r1 = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      authoredAt: new Date(),
      deps,
    });
    assert.equal(r1.ingested, 1);
    assert.equal(r1.deduped, 0);
    assert.equal(getAttachmentCalls, 1);

    // Gmail attachmentIds are immutable, so a second ingest of the same
    // messageId:attachmentId can never produce new content. The row exists,
    // so the whole download → extract → persist → embed chain must be skipped.
    const r2 = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      authoredAt: new Date(),
      deps,
    });
    assert.equal(r2.ingested, 0);
    assert.equal(r2.deduped, 1);
    assert.equal(getAttachmentCalls, 1, "existing attachment must not be re-downloaded");
    assert.equal(indexCalls, 1, "embed must not run again for an existing attachment");

    const rows = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    assert.equal(rows.length, 1, "no duplicate row");
    assert.equal(rows[0]!.content, "version one", "original content preserved");
  });

  test("re-ingest unchanged is idempotent on document row", async () => {
    const userId = await seedUser();
    const accountId = `acc-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const attachmentId = `att-${randomUUID()}`;
    const message = makeMessage({
      id: messageId,
      threadId: `thr-${randomUUID()}`,
      attachmentId,
      filename: "report.pdf",
    });
    const bytes = new Uint8Array(Buffer.from("%PDF-1.4"));
    let indexCalls = 0;
    const deps = {
      getAttachment: async () => ({ bytes, size: bytes.byteLength }),
      media: pdfOnlyMedia(async () => ({
        kind: "extracted" as const,
        format: "pdf" as const,
        content: "same text",
        pages: [{ page: 1, start: 0, end: 9 }],
      })),
      indexDocument: async () => {
        indexCalls++;
        return { documentId: "fake", chunksWritten: 0, chunksSkipped: 1, empty: false };
      },
    };

    const r1 = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      authoredAt: new Date(),
      deps,
    });
    assert.equal(r1.ingested, 1);
    assert.equal(indexCalls, 1);
    const doc1 = (
      await db()
        .select()
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")))
    )[0]!;
    const r2 = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      authoredAt: new Date(),
      deps,
    });
    assert.equal(r2.ingested, 0);
    assert.equal(r2.deduped, 1);
    assert.equal(indexCalls, 1, "embed must not run again for an existing attachment");
    const doc2 = (
      await db()
        .select()
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")))
    )[0]!;
    assert.equal(doc1.id, doc2.id);
    assert.equal(doc1.contentHash, doc2.contentHash);
    // No duplicate row.
    const count = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    assert.equal(count.length, 1);
  });

  test("same content under a different message references the canonical row without re-embedding", async () => {
    const userId = await seedUser();
    const accountId = `acc-${randomUUID()}`;
    const bytes = new Uint8Array(Buffer.from("%PDF-1.4 same file"));
    let indexCalls = 0;
    const threadOne = `thr-${randomUUID()}`;
    const threadTwo = `thr-${randomUUID()}`;

    // First arrival: recruiter thread one — this creates the canonical row.
    const firstMessage = makeMessage({
      id: `msg-${randomUUID()}`,
      threadId: threadOne,
      attachmentId: `att-${randomUUID()}`,
      filename: "resume.pdf",
    });
    const depsFor = () => ({
      getAttachment: async () => ({ bytes, size: bytes.byteLength }),
      media: pdfOnlyMedia(async () => ({
        kind: "extracted" as const,
        format: "pdf" as const,
        content: "resume text",
        pages: [{ page: 1, start: 0, end: 11 }],
      })),
      indexDocument: async () => {
        indexCalls++;
        return { documentId: "fake", chunksWritten: 1, chunksSkipped: 0, empty: false };
      },
    });
    const first = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message: firstMessage,
      accessToken: "t",
      authoredAt: new Date("2026-08-01T10:00:00Z"),
      deps: depsFor(),
    });

    assert.equal(first.ingested, 1);
    assert.equal(indexCalls, 1);

    // Second arrival: identical bytes forwarded to recruiter thread two.
    const attachmentIdTwo = `att-${randomUUID()}`;
    const secondMessage = makeMessage({
      id: `msg-${randomUUID()}`,
      threadId: threadTwo,
      attachmentId: attachmentIdTwo,
      filename: "resume.pdf",
    });
    const second = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message: secondMessage,
      accessToken: "t",
      authoredAt: new Date("2026-08-02T10:00:00Z"),
      deps: depsFor(),
    });

    assert.equal(second.ingested, 0);
    assert.equal(second.referenced, 1);
    assert.equal(indexCalls, 1, "identical content must not embed twice");

    const rows = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    assert.equal(rows.length, 1, "one canonical row per distinct content");

    // eslint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: documents.metadata is jsonb unknown; test narrows to the reference shape ingest wrote.
    const meta = rows[0]!.metadata as { references?: unknown[] };
    assert.ok(Array.isArray(meta.references));
    assert.equal(meta.references!.length, 1);
    assert.deepEqual(meta.references![0], {
      messageId: secondMessage.id,
      attachmentId: attachmentIdTwo,
      threadId: threadTwo,
      accountId,
      filename: "resume.pdf",
      mimeType: "application/pdf",
      size: 1024,
      authoredAt: "2026-08-02T10:00:00.000Z",
    });

    // The canonical row keeps its own provenance: the first carrier thread.
    assert.notEqual(rows[0]!.sourceThreadId, threadTwo);

    // Re-running the second occurrence stays idempotent — no stacked entries.
    const again = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message: secondMessage,
      accessToken: "t",
      authoredAt: new Date("2026-08-02T10:00:00Z"),
      deps: depsFor(),
    });
    assert.equal(again.referenced, 1);
    const after = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    // eslint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: same jsonb narrowing as above.
    const metaAfter = after[0]!.metadata as { references?: unknown[] };
    assert.equal(metaAfter.references!.length, 1, "reference append must be idempotent");
  });

  test("reference append keeps entries that lack dedup keys", async () => {
    const userId = await seedUser();
    const documentId = `doc-${randomUUID()}`;
    // A future writer may store an element without messageId/attachmentId.
    // The append predicate must keep such elements (IS DISTINCT FROM), not
    // silently delete them the way `NOT (NULL AND …)` does.
    await db()
      .insert(documents)
      .values({
        id: documentId,
        userId,
        source: "gmail_attachment",
        sourceId: `msg-${randomUUID()}:att-${randomUUID()}`,
        title: "seed.pdf",
        content: "seed text",
        contentHash: `hash-${randomUUID()}`,
        metadata: {
          references: [
            { foo: "bar" },
            { messageId: "m1", attachmentId: "a1", filename: "a.pdf", size: 1 },
          ],
        },
      });
    const ref = {
      messageId: "m2",
      attachmentId: "a2",
      threadId: null,
      accountId: null,
      filename: "b.pdf",
      size: 2,
      authoredAt: null,
    };

    await appendContentReference(documentId, ref);
    await appendContentReference(documentId, ref);

    const rows = await db().select().from(documents).where(eq(documents.id, documentId));
    // eslint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: documents.metadata is jsonb unknown; test narrows to the reference shape.
    const meta = rows[0]!.metadata as { references?: Array<Record<string, unknown>> };
    assert.equal(meta.references!.length, 3, "malformed entry kept, new entry appended once");
    assert.deepEqual(meta.references![0], { foo: "bar" }, "keyless element must survive");
    assert.deepEqual(meta.references![1], {
      messageId: "m1",
      attachmentId: "a1",
      filename: "a.pdf",
      size: 1,
    });
    assert.deepEqual(meta.references![2], ref, "second identical append must be a no-op");
  });

  test("scanned PDF (needs_ocr) is skipped, not ingested", async () => {
    const userId = await seedUser();
    const accountId = `acc-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const attachmentId = `att-${randomUUID()}`;
    const message = makeMessage({
      id: messageId,
      threadId: `thr-${randomUUID()}`,
      attachmentId,
      filename: "scan.pdf",
    });
    const bytes = new Uint8Array(Buffer.from("%PDF-1.4"));
    const result = await ingestGmailMediaAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      authoredAt: new Date(),
      deps: {
        getAttachment: async () => ({ bytes, size: bytes.byteLength }),
        media: pdfOnlyMedia(async () => ({
          kind: "needs_ocr" as const,
          format: "pdf" as const,
        })),
        indexDocument: async () => {
          assert.fail("indexDocument must not be called for needs_ocr");
        },
      },
    });
    assert.equal(result.skipped, 1);
    assert.equal(result.ingested, 0);
    const rows = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    assert.equal(rows.length, 0);
  });
});
