import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeConnections, db } from "@alfred/db";
import { documents, user } from "@alfred/db/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { ingestGmailPdfAttachments } from "../src/connections/ingestion/gmail-attachment";
import type { GmailMessage } from "@alfred/integrations/google";
import { dbBackedSkip } from "./support/db-backed";

const SKIP = dbBackedSkip("database");
const ID_PREFIX = "test-gmail-att-";
const createdUserIds: string[] = [];

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
    const result = await ingestGmailPdfAttachments({
      userId,
      accountId,
      message,
      accessToken: "fake-token",
      deps: {
        getAttachment: async () => ({ bytes, size: bytes.byteLength }),
        extractPdf: async () => ({
          kind: "extracted",
          pdfType: "text_based",
          pageCount: 2,
          pages: [
            { pageNumber: 1, markdown: "page one text", needsOcr: false },
            { pageNumber: 2, markdown: "page two text", needsOcr: false },
          ],
          pagesNeedingOcr: [],
          text: "page one text\n\npage two text",
        }),
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

  test("re-ingest with changed bytes updates content and re-embeds", async () => {
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
    const bytes = new Uint8Array(Buffer.from("%PDF-1.4"));
    let extractVersion = 0;
    const extractStub = async () => {
      extractVersion++;
      if (extractVersion === 1) {
        return {
          kind: "extracted" as const,
          pdfType: "text_based" as const,
          pageCount: 1,
          pages: [{ pageNumber: 1, markdown: "version one", needsOcr: false }],
          pagesNeedingOcr: [],
          text: "version one",
        };
      }
      return {
        kind: "extracted" as const,
        pdfType: "text_based" as const,
        pageCount: 1,
        pages: [{ pageNumber: 1, markdown: "version two changed", needsOcr: false }],
        pagesNeedingOcr: [],
        text: "version two changed",
      };
    };

    let indexCalls = 0;
    const deps = {
      getAttachment: async () => ({ bytes, size: bytes.byteLength }),
      extractPdf: extractStub,
      indexDocument: async () => {
        indexCalls++;
        return { documentId: "fake", chunksWritten: 1, chunksSkipped: 0, empty: false };
      },
    };

    const r1 = await ingestGmailPdfAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      deps,
    });
    assert.equal(r1.ingested, 1);
    const doc1 = (
      await db()
        .select()
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")))
    )[0]!;
    assert.equal(doc1.content, "version one");
    const hash1 = doc1.contentHash;

    indexCalls = 0;
    const r2 = await ingestGmailPdfAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      deps,
    });
    assert.equal(r2.ingested, 1);
    const doc2 = (
      await db()
        .select()
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")))
    )[0]!;
    assert.equal(doc2.content, "version two changed");
    assert.notEqual(
      doc2.contentHash,
      hash1,
      "contentHash must change on re-ingest with changed bytes",
    );
    assert.equal(doc2.id, doc1.id, "same document row updated, not duplicated");
    assert.equal(indexCalls, 1, "re-embed called for changed content");
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
    const deps = {
      getAttachment: async () => ({ bytes, size: bytes.byteLength }),
      extractPdf: async () => ({
        kind: "extracted" as const,
        pdfType: "text_based" as const,
        pageCount: 1,
        pages: [{ pageNumber: 1, markdown: "same text", needsOcr: false }],
        pagesNeedingOcr: [],
        text: "same text",
      }),
      indexDocument: async () => ({
        documentId: "fake",
        chunksWritten: 0,
        chunksSkipped: 1,
        empty: false,
      }),
    };

    await ingestGmailPdfAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      deps,
    });
    const doc1 = (
      await db()
        .select()
        .from(documents)
        .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")))
    )[0]!;
    await ingestGmailPdfAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      deps,
    });
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
    const result = await ingestGmailPdfAttachments({
      userId,
      accountId,
      message,
      accessToken: "t",
      deps: {
        getAttachment: async () => ({ bytes, size: bytes.byteLength }),
        extractPdf: async () => ({ kind: "needs_ocr", pdfType: "scanned", pageCount: 2 }),
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
