import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { closeConnections, db } from "@alfred/db";
import type { SealedCredentialSecret } from "@alfred/db/credential-vault";
import { documents, ingestionState, integrationCredentials, user } from "@alfred/db/schemas";
import { findUnembeddedDocumentIds } from "@alfred/corpus";
import { and, eq, inArray } from "drizzle-orm";

// Imports the RELOCATED consumer module (Phase-5 item 01). The cursor-seed
// logic used to live in the provider package's `google/watch.ts`
// (`seedHistoryCursorIfAbsent`); it now lives here so `@alfred/integrations`
// writes no ingestion-domain tables. This test pins the relocated seam so a
// byte-identical move is provably unchanged — and it is the one delicate piece
// of the move (Risk: a watch install that fails to seed a cursor drops a
// freshly-watched credential into perpetual full re-sync).
import {
  pollGmailRecent,
  seedGmailHistoryCursorIfAbsent,
} from "@alfred/assistant/connections/ingestion/internal";
import type { GmailMessage } from "@alfred/integrations/google";
import { dbBackedSkip } from "./support/db-backed";

const ID_PREFIX = "test-gmail-ingest-";
const SKIP = dbBackedSkip("database");

const createdUserIds: string[] = [];

after(async () => {
  if (createdUserIds.length) {
    // integration_credentials + ingestion_state cascade on user delete.
    await db().delete(user).where(inArray(user.id, createdUserIds));
  }
  await closeConnections();
});

async function seedUser(): Promise<string> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Gmail Ingest Test", email: `${userId}@example.test` });
  return userId;
}

async function seedGoogleCredential(userId: string): Promise<string> {
  const [row] = await db()
    .insert(integrationCredentials)
    .values({
      userId,
      provider: "google",
      accountId: randomUUID(),
      accountLabel: `${userId}@example.test`,
      // Deliberate unsealed write: this test never opens the token; the seed
      // path only reads `user_id` off the credential row.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
      accessToken: "access-token" as unknown as SealedCredentialSecret,
      // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- boundary cast: source type is structurally incompatible with target
      refreshToken: "refresh-token" as unknown as SealedCredentialSecret,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
      status: "active",
    })
    .returning({ id: integrationCredentials.id });
  assert.ok(row);
  return row.id;
}

async function loadCursor(credentialId: string): Promise<{
  historyId: string | undefined;
  lastSyncAt: Date | null;
} | null> {
  const rows = await db()
    .select({ state: ingestionState.state, lastSyncAt: ingestionState.lastSyncAt })
    .from(ingestionState)
    .where(
      and(eq(ingestionState.credentialId, credentialId), eq(ingestionState.stream, "messages")),
    );
  const row = rows[0];
  if (!row) return null;
  const state = row.state as { historyId?: string } | undefined;
  return { historyId: state?.historyId, lastSyncAt: row.lastSyncAt };
}

describe(
  "seedGmailHistoryCursorIfAbsent — relocated cursor seed (DB-backed)",
  { skip: SKIP },
  () => {
    test("seeds a messages-stream cursor row when none exists", async () => {
      const userId = await seedUser();
      const credentialId = await seedGoogleCredential(userId);

      assert.equal(await loadCursor(credentialId), null, "no cursor before seed");

      await seedGmailHistoryCursorIfAbsent({ credentialId, historyId: "1000" });

      const seeded = await loadCursor(credentialId);
      assert.ok(seeded, "cursor row exists after seed");
      assert.equal(seeded.historyId, "1000", "cursor seeded to the watch baseline historyId");
      assert.equal(seeded.lastSyncAt, null, "seed leaves last_sync_at null (no delta synced yet)");
    });

    test("is a no-op that never resets an existing cursor (renewal safety)", async () => {
      const userId = await seedUser();
      const credentialId = await seedGoogleCredential(userId);

      await seedGmailHistoryCursorIfAbsent({ credentialId, historyId: "1000" });
      // A renewal re-seeds with a fresh baseline; it must NOT roll the rolling
      // cursor backward or forward — the poll/webhook deltas own it after seed.
      await seedGmailHistoryCursorIfAbsent({ credentialId, historyId: "500" });

      const after = await loadCursor(credentialId);
      assert.ok(after);
      assert.equal(after.historyId, "1000", "existing cursor preserved across re-seed");
    });

    test("throws when the credential row is absent (FK cannot be satisfied)", async () => {
      await assert.rejects(
        () =>
          seedGmailHistoryCursorIfAbsent({
            credentialId: `missing-${randomUUID()}`,
            historyId: "1",
          }),
        /credential vanished mid-install/,
      );
    });
  },
);

function makePollMessage(args: {
  id: string;
  threadId: string;
  attachmentId: string;
  filename: string;
  historyId: string;
}): GmailMessage {
  // eslint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test factory builds minimal GmailMessage; parser only reads id/threadId/labelIds/payload/historyId.
  return {
    id: args.id,
    threadId: args.threadId,
    labelIds: [],
    snippet: "test snippet",
    historyId: args.historyId,
    internalDate: String(Date.now()),
    payload: {
      headers: [
        { name: "Subject", value: "Test mail with PDF" },
        { name: "From", value: "sender@example.com" },
      ],
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("hello").toString("base64url") } },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: args.filename,
          body: { attachmentId: args.attachmentId, size: 1024 },
        },
      ],
    },
    sizeEstimate: 2048,
  } as unknown as GmailMessage;
}

describe("pollGmailRecent — knownRefs attachment retry (DB-backed)", { skip: SKIP }, () => {
  test("transient getAttachment failure on known message is retried on next poll and not permanently orphaned", async () => {
    const userId = await seedUser();
    const credentialId = await seedGoogleCredential(userId);
    const threadId = `thr-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const attachmentId = `att-${randomUUID()}`;
    const historyId = "2000";

    await db()
      .insert(documents)
      .values({
        userId,
        source: "gmail",
        sourceId: messageId,
        sourceThreadId: threadId,
        accountId: `acc-${randomUUID()}`,
        title: "Test mail with PDF",
        content: "From: sender@example.com\n\nhello",
        contentHash: randomUUID(),
        metadata: {
          from: "sender@example.com",
          labelIds: [],
          isSent: false,
          internalDate: String(Date.now()),
          historyId,
          // Production sequence: the first attempt failed on the unknown path,
          // which stamped this flag. The realtime retry only re-fetches
          // flagged known messages.
          mediaPending: true,
        },
        raw: { id: messageId },
        authoredAt: new Date(),
      });

    const message = makePollMessage({
      id: messageId,
      threadId,
      attachmentId,
      filename: "retry.pdf",
      historyId,
    });

    let getAttachmentCalls = 0;
    let getMessageCalls = 0;
    const failOnceThenSucceed = async () => {
      getAttachmentCalls++;
      if (getAttachmentCalls === 1) throw new Error("transient getAttachment failure");
      return { bytes: new Uint8Array(Buffer.from("%PDF-1.4 fake")), size: 1024 };
    };

    let indexCalls = 0;
    const result1 = await pollGmailRecent({
      credentialId,
      window: "5m",
      maxMessages: 10,
      deps: {
        getFreshAccessToken: async () => "fake-token",
        listMessages: async () => ({
          messages: [{ id: messageId, threadId }],
          nextPageToken: undefined,
        }),
        getMessage: async () => {
          getMessageCalls++;
          return message;
        },
        media: {
          getAttachment: failOnceThenSucceed,
          allowedFamilies: ["pdf"] as const,
          createExtractor: () => async () => ({
            kind: "extracted" as const,
            family: "pdf" as const,
            content: "pdf text from retry",
            pages: [{ page: 1, start: 0, end: 8 }],
          }),
          indexDocument: async () => {
            indexCalls++;
            return { documentId: "fake", chunksWritten: 1, chunksSkipped: 0, empty: false };
          },
        },
      },
    });

    assert.equal(result1.listed, 1);
    assert.equal(result1.inserted, 0);
    assert.equal(result1.skipped, 1);
    assert.equal(result1.mediaErrors, 1, "transient attachment fetch counted in mediaErrors");
    assert.equal(result1.mediaIngested, 0);
    assert.equal(indexCalls, 0, "index not called when fetch failed");
    assert.equal(getMessageCalls, 1, "flagged known message is re-fetched for the retry");

    const beforeRows = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    assert.equal(beforeRows.length, 0, "no gmail_attachment row after transient failure");

    indexCalls = 0;
    const result2 = await pollGmailRecent({
      credentialId,
      window: "5m",
      maxMessages: 10,
      deps: {
        getFreshAccessToken: async () => "fake-token",
        listMessages: async () => ({
          messages: [{ id: messageId, threadId }],
          nextPageToken: undefined,
        }),
        getMessage: async () => {
          getMessageCalls++;
          return message;
        },
        media: {
          getAttachment: async () => ({
            bytes: new Uint8Array(Buffer.from("%PDF-1.4 fake")),
            size: 1024,
          }),
          allowedFamilies: ["pdf"] as const,
          createExtractor: () => async () => ({
            kind: "extracted" as const,
            family: "pdf" as const,
            content: "pdf text from retry",
            pages: [{ page: 1, start: 0, end: 8 }],
          }),
          indexDocument: async () => {
            indexCalls++;
            return { documentId: "fake", chunksWritten: 1, chunksSkipped: 0, empty: false };
          },
        },
      },
    });

    assert.equal(result2.mediaIngested, 1);
    assert.equal(result2.mediaErrors, 0);
    assert.equal(result2.mediaEmbedFailures, 0);
    assert.equal(result2.mediaDeduped, 0, "no row existed after the transient failure");
    assert.equal(indexCalls, 1, "retry re-embeds the PDF");
    assert.equal(result2.mediaDocumentIds.length, 1);

    const afterRows = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    assert.equal(afterRows.length, 1);
    assert.equal(afterRows[0]!.sourceId, `${messageId}:${attachmentId}`);
    assert.equal(afterRows[0]!.content, "pdf text from retry");

    // Success cleared the flag: the next poll must not re-fetch the message.
    const callsBeforePoll3 = getMessageCalls;
    const result3 = await pollGmailRecent({
      credentialId,
      window: "5m",
      maxMessages: 10,
      deps: {
        getFreshAccessToken: async () => "fake-token",
        listMessages: async () => ({
          messages: [{ id: messageId, threadId }],
          nextPageToken: undefined,
        }),
        getMessage: async () => {
          getMessageCalls++;
          return message;
        },
        media: {
          getAttachment: async () => ({ bytes: new Uint8Array(Buffer.from("%PDF-1.4")), size: 9 }),
          indexDocument: async () => {
            throw new Error("indexDocument must not run for an unflagged known message");
          },
        },
      },
    });
    assert.equal(result3.mediaErrors, 0);
    assert.equal(
      getMessageCalls,
      callsBeforePoll3,
      "unflagged known message must not be re-fetched",
    );
  });

  test("attachment embed failure is counted in mediaEmbedFailures and does not fail mail poll", async () => {
    const userId = await seedUser();
    const credentialId = await seedGoogleCredential(userId);
    const threadId = `thr-${randomUUID()}`;
    const messageId = `msg-${randomUUID()}`;
    const attachmentId = `att-${randomUUID()}`;
    const message = makePollMessage({
      id: messageId,
      threadId,
      attachmentId,
      filename: "embed-fail.pdf",
      historyId: "3000",
    });

    const result = await pollGmailRecent({
      credentialId,
      maxMessages: 10,
      deps: {
        getFreshAccessToken: async () => "fake-token",
        listMessages: async () => ({
          messages: [{ id: messageId, threadId }],
          nextPageToken: undefined,
        }),
        getMessage: async () => message,
        media: {
          getAttachment: async () => ({
            bytes: new Uint8Array(Buffer.from("%PDF-1.4")),
            size: 1024,
          }),
          allowedFamilies: ["pdf"] as const,
          createExtractor: () => async () => ({
            kind: "extracted" as const,
            family: "pdf" as const,
            content: "embed me",
            pages: null,
          }),
          indexDocument: async () => {
            throw new Error("voyage down");
          },
        },
      },
    });

    assert.equal(result.inserted, 1);
    assert.equal(result.mediaIngested, 0, "ingested counts only successful embeds");
    assert.equal(result.mediaEmbedFailures, 1);
    assert.equal(result.mediaErrors, 0);
    assert.equal(result.errors, 0, "attachment embed failure does not bubble to poll errors");

    const attRows = await db()
      .select()
      .from(documents)
      .where(and(eq(documents.userId, userId), eq(documents.source, "gmail_attachment")));
    assert.equal(attRows.length, 1);
    assert.equal(attRows[0]!.sourceId, `${messageId}:${attachmentId}`);

    // The corpus sweep is the recovery path for this exact state (row
    // persisted, transient embed failure, no chunks). It must select
    // `gmail_attachment` rows — the queue's gmail.embed_sweep sweeps both
    // sources; this pins the candidate half of that wiring.
    const sweepCandidates = await findUnembeddedDocumentIds({
      source: "gmail_attachment",
      limit: 50,
    });
    assert.ok(
      sweepCandidates.includes(attRows[0]!.id),
      "embed_sweep candidate query must cover gmail_attachment rows",
    );
  });
});
