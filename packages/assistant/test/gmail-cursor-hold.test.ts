import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { getStringPath, HttpError } from "@alfred/contracts";
import { closeConnections, db } from "@alfred/db";
import { ingestionState, integrationCredentials, user } from "@alfred/db/schemas";
import type { GmailHistoryEntry, GmailMessage } from "@alfred/integrations/google";
import { and, eq, inArray, sql } from "drizzle-orm";
import { dbBackedSkip } from "./support/db-backed";
import { unsealedTestSecret } from "./support/unsealed-secret";
import { pollGmailHistory, pollGmailRecent } from "../src/connections/ingestion/gmail-ingest";

// SM-01 in docs/reference/state-machines.md: the history cursor must never pass the add record of
// a message this run failed to store, or `history.list` never returns it again and the mail is lost.

const ID_PREFIX = "test-gmail-cursor-hold-";

const SKIP = dbBackedSkip("database");

const createdUserIds: string[] = [];

after(async () => {
  if (createdUserIds.length) {
    await db().delete(user).where(inArray(user.id, createdUserIds));
  }

  await closeConnections();
});

async function seedCredential(): Promise<{ userId: string; credentialId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Cursor Hold Test", email: `${userId}@example.test` });

  const [row] = await db()
    .insert(integrationCredentials)
    .values({
      userId,
      provider: "google",
      accountId: randomUUID(),
      accountLabel: `${userId}@example.test`,
      accessToken: unsealedTestSecret("access-token"),
      refreshToken: unsealedTestSecret("refresh-token"),
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
      status: "active",
    })
    .returning({ id: integrationCredentials.id });

  assert.ok(row);

  return { userId, credentialId: row.id };
}

async function setCursor(credentialId: string, userId: string, historyId: string): Promise<void> {
  await db()
    .insert(ingestionState)
    .values({
      credentialId,
      userId,
      provider: "google",
      stream: "messages",
      state: { historyId },
    })
    .onConflictDoUpdate({
      target: [ingestionState.credentialId, ingestionState.stream],
      set: { state: sql`jsonb_build_object('historyId', ${historyId}::text)` },
    });
}

async function readCursor(credentialId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ state: ingestionState.state })
    .from(ingestionState)
    .where(
      and(eq(ingestionState.credentialId, credentialId), eq(ingestionState.stream, "messages")),
    );

  return row ? getStringPath(row.state, "historyId") : undefined;
}

function plainMessage(id: string, threadId: string, historyId: string): GmailMessage {
  return {
    id,
    threadId,
    labelIds: ["INBOX"],
    snippet: "hello",
    historyId,
    internalDate: String(Date.now()),
    payload: {
      headers: [
        { name: "Subject", value: "Cursor hold" },
        { name: "From", value: "sender@example.com" },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from("hello").toString("base64url") },
    },
    sizeEstimate: 256,
  };
}

function gmailError(status: number): HttpError {
  return new HttpError({
    provider: "gmail",
    status,
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/x",
    body: "",
  });
}

function added(historyId: string, id: string, threadId: string): GmailHistoryEntry {
  return { id: historyId, messagesAdded: [{ message: { id, threadId } }] };
}

describe("Gmail cursor holds below mail it did not store (DB-backed)", { skip: SKIP }, () => {
  test("realtime: a failed fetch keeps the cursor where it was", async () => {
    const { userId, credentialId } = await seedCredential();
    await setCursor(credentialId, userId, "1000");

    const failed = `msg-${randomUUID()}`;
    const stored = `msg-${randomUUID()}`;

    const result = await pollGmailRecent({
      credentialId,
      maxMessages: 10,
      deps: {
        mailbox: {
          listMessages: async () => ({
            messages: [
              { id: failed, threadId: `thr-${randomUUID()}` },
              { id: stored, threadId: `thr-${randomUUID()}` },
            ],
            nextPageToken: undefined,
          }),
          getMessage: async ({ id }) => {
            if (id === failed) throw gmailError(429);

            return plainMessage(stored, `thr-${randomUUID()}`, "2000");
          },
        },
      },
    });

    assert.equal(result.inserted, 1);
    assert.equal(result.errors, 1);
    assert.equal(result.cursorAfter, "1000");
    assert.equal(await readCursor(credentialId), "1000");
  });

  test("realtime: a list cut at the cap keeps the cursor where it was", async () => {
    const { userId, credentialId } = await seedCredential();
    await setCursor(credentialId, userId, "1000");

    const stored = `msg-${randomUUID()}`;

    const result = await pollGmailRecent({
      credentialId,
      maxMessages: 1,
      deps: {
        mailbox: {
          listMessages: async () => ({
            messages: [{ id: stored, threadId: `thr-${randomUUID()}` }],
            nextPageToken: "more",
          }),
          getMessage: async () => plainMessage(stored, `thr-${randomUUID()}`, "2000"),
        },
      },
    });

    assert.equal(result.inserted, 1);
    assert.equal(await readCursor(credentialId), "1000");
  });

  test("realtime: a clean run still advances the cursor", async () => {
    const { userId, credentialId } = await seedCredential();
    await setCursor(credentialId, userId, "1000");

    const stored = `msg-${randomUUID()}`;

    await pollGmailRecent({
      credentialId,
      maxMessages: 10,
      deps: {
        mailbox: {
          listMessages: async () => ({
            messages: [{ id: stored, threadId: `thr-${randomUUID()}` }],
            nextPageToken: undefined,
          }),
          getMessage: async () => plainMessage(stored, `thr-${randomUUID()}`, "2000"),
        },
      },
    });

    assert.equal(await readCursor(credentialId), "2000");
  });

  /**
   * Store `known` through the realtime path first, so the catch-up run only skips it and never
   * reaches the embed call, then put the cursor back to 1000.
   */
  async function seedKnownMessage(): Promise<{ credentialId: string; known: string }> {
    const { userId, credentialId } = await seedCredential();
    const known = `msg-${randomUUID()}`;

    await pollGmailRecent({
      credentialId,
      maxMessages: 10,
      deps: {
        mailbox: {
          listMessages: async () => ({
            messages: [{ id: known, threadId: `thr-${randomUUID()}` }],
            nextPageToken: undefined,
          }),
          getMessage: async () => plainMessage(known, `thr-${randomUUID()}`, "1020"),
        },
      },
    });

    await setCursor(credentialId, userId, "1000");

    return { credentialId, known };
  }

  test("catch-up: a retryable failure holds the cursor just below its add record", async () => {
    const { credentialId, known } = await seedKnownMessage();
    const failed = `msg-${randomUUID()}`;
    const starts: string[] = [];

    const result = await pollGmailHistory({
      credentialId,
      deps: {
        mailbox: {
          listHistory: async ({ startHistoryId }) => {
            starts.push(startHistoryId);

            return {
              entries: [added("1010", failed, "thr-a"), added("1020", known, "thr-b")],
              nextPageToken: undefined,
              historyId: "1020",
            };
          },
          getMessage: async ({ id }) => {
            if (id === failed) throw gmailError(503);

            return plainMessage(known, "thr-b", "1020");
          },
        },
      },
    });

    assert.deepEqual(starts, ["1000"]);
    assert.equal(result.errors, 1);
    assert.equal(result.cursorAfter, "1009");
    assert.equal(await readCursor(credentialId), "1009");
  });

  test("catch-up: a deleted message (404) does not pin the cursor", async () => {
    const { credentialId, known } = await seedKnownMessage();
    const deleted = `msg-${randomUUID()}`;

    await pollGmailHistory({
      credentialId,
      deps: {
        mailbox: {
          listHistory: async () => ({
            entries: [added("1010", deleted, "thr-a"), added("1020", known, "thr-b")],
            nextPageToken: undefined,
            historyId: "1020",
          }),
          getMessage: async ({ id }) => {
            if (id === deleted) throw gmailError(404);

            return plainMessage(known, "thr-b", "1020");
          },
        },
      },
    });

    assert.equal(await readCursor(credentialId), "1020");
  });
});
