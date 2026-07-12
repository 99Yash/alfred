import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";

import { closeConnections, db } from "@alfred/db";
import {
  chatAttachmentRepresentations,
  chatAttachments,
  chatMessages,
  chatThreadContext,
  chatThreads,
  user,
} from "@alfred/db/schemas";
import { databaseEnv } from "@alfred/env/database";
import { eq, inArray, sql } from "drizzle-orm";

import { persistChatAttachmentRepresentation } from "../../src/modules/chat/attachment-enrichment";
import {
  loadConversationSummaryEvidence,
  persistConversationSummary,
} from "../../src/modules/agent/compaction";

const SKIP = (() => {
  try {
    databaseEnv();
    return false;
  } catch {
    return "DATABASE_URL not set — skipping DB-backed test";
  }
})();

const ID_PREFIX = "test-compaction-db-";
const createdUserIds: string[] = [];

async function seedThread(): Promise<{ userId: string; threadId: string }> {
  const userId = `${ID_PREFIX}${randomUUID()}`;
  const threadId = `thread_${randomUUID()}`;
  createdUserIds.push(userId);
  await db()
    .insert(user)
    .values({ id: userId, name: "Compaction Test", email: `${userId}@example.test` });
  await db().insert(chatThreads).values({ id: threadId, userId });
  return { userId, threadId };
}

describe("conversation compaction database invariants", { skip: SKIP }, () => {
  after(async () => {
    if (createdUserIds.length > 0) {
      await db().delete(user).where(inArray(user.id, createdUserIds));
    }
    await closeConnections();
  });

  test("loads a microsecond Postgres boundary through its millisecond Date watermark", async () => {
    const { userId, threadId } = await seedThread();
    const messageId = `msg_${randomUUID()}`;
    await db().execute(sql`
      insert into chat_messages (id, user_id, thread_id, role, content, status, created_at, updated_at)
      values (
        ${messageId}, ${userId}, ${threadId}, 'assistant', 'boundary', 'complete',
        '2026-07-12T00:00:00.123456Z'::timestamptz,
        '2026-07-12T00:00:00.123456Z'::timestamptz
      )
    `);

    const loaded = await loadConversationSummaryEvidence({
      userId,
      threadId,
      priorSummary: null,
      afterWatermark: null,
      throughWatermark: {
        messageId,
        createdAt: new Date("2026-07-12T00:00:00.123Z"),
      },
    });

    assert.equal(loaded.evidence.messages.at(-1)?.id, messageId);
  });

  test("summary CAS ignores a concurrently advanced replay estimate and admits one writer", async () => {
    const { userId, threadId } = await seedThread();
    const messageId = `msg_${randomUUID()}`;
    const watermark = { messageId, createdAt: new Date("2026-07-12T00:00:00.123Z") };
    await db().insert(chatMessages).values({
      id: messageId,
      userId,
      threadId,
      role: "assistant",
      content: "boundary",
      createdAt: watermark.createdAt,
    });
    await db().insert(chatThreadContext).values({
      userId,
      threadId,
      estimatedReplayTokens: 99,
      replayEstimateWatermarkCreatedAt: watermark.createdAt,
      replayEstimateWatermarkMessageId: messageId,
    });
    const summary = {
      schemaVersion: 1 as const,
      overview: {
        text: "Conversation summary.",
        sourceMessageRange: { fromMessageId: messageId, toMessageId: messageId },
      },
      facts: [],
      preferences: [],
      instructions: [],
      decisions: [],
      actionOutcomes: [],
      unresolvedQuestions: [],
      importantEntities: [],
    };
    const args = {
      userId,
      threadId,
      summary,
      watermark,
      expectedGeneration: 0,
      expectedWatermark: null,
      estimatedReplayTokens: 10,
      replayEstimateWatermark: watermark,
      eligibleSources: {
        messageIds: new Set([messageId]),
        toolIds: new Set<string>(),
        attachmentIds: new Set<string>(),
      },
    };

    assert.equal(await persistConversationSummary(args), true);
    assert.equal(await persistConversationSummary(args), false);
    const [context] = await db()
      .select({ generation: chatThreadContext.compactionGeneration })
      .from(chatThreadContext)
      .where(eq(chatThreadContext.threadId, threadId));
    assert.equal(context?.generation, 1);
  });

  test("a successful enrichment retry replaces the prior failed state", async () => {
    const { userId, threadId } = await seedThread();
    const messageId = `msg_${randomUUID()}`;
    const attachmentId = `att_${randomUUID()}`;
    await db().insert(chatMessages).values({
      id: messageId,
      userId,
      threadId,
      role: "user",
      content: "attachment",
    });
    await db().insert(chatAttachments).values({
      id: attachmentId,
      userId,
      messageId,
      storageKey: "test/key",
      name: "image.png",
      mime: "image/png",
      size: 10,
    });
    await db().insert(chatAttachmentRepresentations).values({
      attachmentId,
      representationVersion: 1,
      status: "failed",
      failureCategory: "generation_failed",
    });

    const persisted = await persistChatAttachmentRepresentation({
      representation: {
        schemaVersion: 1,
        attachmentId,
        messageId,
        mime: "image/png",
        visualDescription: "A retry result.",
        ocrText: null,
        salientEntities: [],
        evidence: [],
      },
      provider: "cascade",
      model: "media-enrichment",
      estimatedCostMicrousd: 20_000,
    });

    assert.equal(persisted, true);
    const [row] = await db()
      .select({
        status: chatAttachmentRepresentations.status,
        failureCategory: chatAttachmentRepresentations.failureCategory,
      })
      .from(chatAttachmentRepresentations)
      .where(eq(chatAttachmentRepresentations.attachmentId, attachmentId));
    assert.deepEqual(row, { status: "ready", failureCategory: null });
  });
});
