import {
  Errors,
  getPath,
  isPdfContentType,
  isNonEmptyString,
  MAX_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  toMessage,
  type TurnStartResponse,
} from "@alfred/contracts";
import { db, type DbRoot, type DbTransaction } from "@alfred/db";
import { createId } from "@alfred/db/helpers";
import { uniqueViolationConstraint } from "@alfred/db/pg-errors";
import {
  agentRuns,
  artifacts,
  CHAT_THREAD_ACTIVE_RUN_INDEX,
  chatAttachments,
  chatMessages,
  chatThreadRunMatch,
  chatThreads,
  runIsNotTerminal,
} from "@alfred/db/schemas";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";

import { getRun, persistChatTurnRunInTx, redeliverRun } from "@alfred/assistant/execution";
import { emitReplicachePokes } from "@alfred/assistant/triggers";

import {
  assertAttachmentBatchAllowed,
  assertStoredAttachmentReady,
  buildAttachmentKey,
  copyObject,
  isStorageConfigured,
  lockChatStorageKeys,
  toAttachmentRow,
} from "./attachments";
import { releasePendingUploadBudget } from "./attachment-upload-quota";
import { resolveAttachmentDegradation, schedulePendingUploadCleanup } from "./attachment-ingest";
import { CHAT_TURN_WORKFLOW_SLUG } from "./chat-turn";
import { requestChatStop } from "./stop-signal";
import {
  attachmentRequestMatchesExistingRows,
  sameInsertedAttachmentRows,
  type ExistingAttachmentSummary,
  type FreshAttachmentDescriptor,
  type RetryAttachmentSource,
} from "./turn-attachment-reconciliation";
import type { NewChatAttachment } from "@alfred/db/schemas";

/**
 * Turn admission (ADR-0089): every durable decision of a chat send is made here.
 * `packages/http/src/chat.ts` only reads the request and writes the response.
 */

const TITLE_MAX_CHARS = 80;

type DbExecutor = DbRoot | DbTransaction;

interface ExistingChatTurnRun {
  runId: string | null;
  assistantMessageId: string;
}

async function findExistingChatTurnRun(
  ex: DbExecutor,
  userId: string,
  userMessageId: string,
  fallbackAssistantMessageId: string,
  artifactTargetId: string | undefined,
): Promise<ExistingChatTurnRun | null> {
  const active = await ex
    .select({ id: agentRuns.id, metadata: agentRuns.metadata })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.workflowSlug, CHAT_TURN_WORKFLOW_SLUG),
        eq(agentRuns.dedupKey, `chat:${userMessageId}`),
        // Not `runIsNotTerminal`: the dedup index keeps `completed` runs, so a done turn reads as done.
        notInArray(agentRuns.status, ["failed", "cancelled"]),
      ),
    )
    .limit(1);

  const existing = active[0];

  if (!existing) return null;
  const storedArtifactTargetId = getPath(existing.metadata, "artifactTargetId");

  const normalizedStoredTarget = isNonEmptyString(storedArtifactTargetId)
    ? storedArtifactTargetId
    : undefined;

  if (normalizedStoredTarget !== artifactTargetId) {
    throw Errors.ConflictError("Message id already belongs to a different chat turn");
  }

  const existingAssistantId = getPath(existing.metadata, "assistantMessageId");

  return {
    runId: existing.id,
    assistantMessageId: isNonEmptyString(existingAssistantId)
      ? existingAssistantId
      : fallbackAssistantMessageId,
  };
}

/**
 * The in-flight run on this thread for a different user message, or `null` (#488).
 * A fast path in front of {@link CHAT_THREAD_ACTIVE_RUN_INDEX}, which is the race-safe guard.
 */
async function findBlockingChatTurnRun(
  ex: DbExecutor,
  userId: string,
  threadId: string,
  userMessageId: string,
): Promise<string | null> {
  const active = await ex
    .select({ id: agentRuns.id, metadata: agentRuns.metadata })
    .from(agentRuns)
    .where(
      and(
        // Built from the index's own expressions, so the two cannot disagree.
        chatThreadRunMatch(agentRuns, { userId, threadId }),
        runIsNotTerminal(agentRuns.status),
      ),
    )
    .limit(1);

  const existing = active[0];

  if (!existing) return null;
  const runUserMessageId = getPath(existing.metadata, "userMessageId");

  // The same user message is a retry, not a busy thread.
  if (runUserMessageId === userMessageId) return null;

  return existing.id;
}

async function loadAttachmentSummaries(
  ex: DbExecutor,
  userId: string,
  messageId: string,
): Promise<ExistingAttachmentSummary[]> {
  return await ex
    .select({
      id: chatAttachments.id,
      name: chatAttachments.name,
      mime: chatAttachments.mime,
      size: chatAttachments.size,
      position: chatAttachments.position,
    })
    .from(chatAttachments)
    .where(and(eq(chatAttachments.userId, userId), eq(chatAttachments.messageId, messageId)))
    .orderBy(
      asc(chatAttachments.position),
      asc(chatAttachments.createdAt),
      asc(chatAttachments.id),
    );
}

async function enqueueChatTurnRunBestEffort(runId: string | null | undefined): Promise<void> {
  if (!runId) return;

  try {
    await redeliverRun(runId);
  } catch (err) {
    // The run row is durable and the resume sweep re-enqueues it, so the send did not fail.
    console.warn("[chat] run enqueue failed; resume sweep will recover:", toMessage(err));
  }
}

/** Set the Redis stop flag. Rejects a run that is not a chat turn, is finished, or waits on an approval. */
export async function stopChatTurn(runId: string, userId: string): Promise<{ ok: true }> {
  const run = await getRun(runId, userId);

  if (!run) throw Errors.NotFoundError("Run not found");

  if (run.workflowSlug !== CHAT_TURN_WORKFLOW_SLUG) {
    throw Errors.BadRequestError("Not a chat run");
  }

  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    throw Errors.ConflictError("Run already finished");
  }

  if (run.status === "waiting") {
    throw Errors.ConflictError("Run is awaiting approval — resolve the approval instead");
  }

  const recorded = await requestChatStop(runId);

  if (!recorded)
    throw Errors.ServiceUnavailableError("Couldn't reach the stop channel — try again");

  return { ok: true };
}

export interface StartChatTurnInput {
  userId: string;
  threadId: string;
  userMessageId: string;
  content: string;
  tier?: "standard" | "deep" | undefined;
  artifactTargetId?: string | undefined;
  attachments?: FreshAttachmentDescriptor[] | undefined;
  retryAttachmentIds?: string[] | undefined;
  retryAttachmentMessageId?: string | null | undefined;
}

/** Validate, write the user turn, and start its run. Returns busy, reuse, or started. */
export async function startChatTurn(input: StartChatTurnInput): Promise<TurnStartResponse> {
  const { userId, threadId, tier, artifactTargetId } = input;
  const userMessageId = input.userMessageId;
  const content = input.content.trim();
  const attachments = input.attachments ?? [];
  const retryAttachmentIds = input.retryAttachmentIds ?? [];
  const retryAttachmentMessageId = input.retryAttachmentMessageId ?? null;
  assertAttachmentBatchAllowed(attachments);

  // Text or at least one attachment. An image-only send is valid.
  if (content.length === 0 && attachments.length === 0 && retryAttachmentIds.length === 0) {
    throw Errors.BadRequestError("A message must have text or an attachment");
  }

  if (retryAttachmentIds.length > 0 && !retryAttachmentMessageId) {
    throw Errors.BadRequestError("Retry attachments must include their source message");
  }

  const storageConfigured = isStorageConfigured();

  if ((attachments.length > 0 || retryAttachmentIds.length > 0) && !storageConfigured) {
    throw Errors.ServiceUnavailableError("File storage isn't configured");
  }

  const existing = await db()
    .select({ userId: chatThreads.userId, title: chatThreads.title })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  const thread = existing[0];

  if (thread && thread.userId !== userId) {
    throw Errors.NotFoundError("thread not found");
  }

  if (artifactTargetId) {
    const ownedTargets = await db()
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, artifactTargetId),
          eq(artifacts.userId, userId),
          eq(artifacts.threadId, threadId),
        ),
      )
      .limit(1);

    if (!ownedTargets[0]) {
      throw Errors.BadRequestError("Artifact target doesn't belong to this chat");
    }
  }

  // Reject a reused id with different content before any side effect.
  const existingMessages = await db()
    .select({
      userId: chatMessages.userId,
      threadId: chatMessages.threadId,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, userMessageId))
    .limit(1);

  const existingMessage = existingMessages[0];

  if (
    existingMessage &&
    (existingMessage.userId !== userId || existingMessage.threadId !== threadId)
  ) {
    throw Errors.ConflictError("Message id already belongs to another chat message");
  }

  if (existingMessage && existingMessage.content !== content) {
    throw Errors.ConflictError("Message id already belongs to a different chat turn");
  }

  // Busy check before any side effect (#488). The index below catches the race.
  const blockingRunId = await findBlockingChatTurnRun(db(), userId, threadId, userMessageId);

  if (blockingRunId) {
    return { outcome: "busy", runId: blockingRunId } satisfies TurnStartResponse;
  }

  const retrySources: RetryAttachmentSource[] = [];

  if (retryAttachmentIds.length > 0) {
    const sources = await db()
      .select({
        id: chatAttachments.id,
        storageKey: chatAttachments.storageKey,
        name: chatAttachments.name,
        mime: chatAttachments.mime,
        size: chatAttachments.size,
        degradedText: chatAttachments.degradedText,
      })
      .from(chatAttachments)
      .innerJoin(chatMessages, eq(chatMessages.id, chatAttachments.messageId))
      .where(
        and(
          inArray(chatAttachments.id, retryAttachmentIds),
          eq(chatAttachments.userId, userId),
          eq(chatAttachments.messageId, retryAttachmentMessageId ?? ""),
          eq(chatAttachments.status, "ready"),
          eq(chatMessages.userId, userId),
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "user"),
        ),
      )
      .orderBy(
        asc(chatAttachments.position),
        asc(chatAttachments.createdAt),
        asc(chatAttachments.id),
      );

    const sourcesById = new Map(sources.map((source) => [source.id, source]));
    const orderedSources: RetryAttachmentSource[] = [];

    for (const id of retryAttachmentIds) {
      const source = sourcesById.get(id);

      if (source) orderedSources.push(source);
    }

    if (orderedSources.length !== new Set(retryAttachmentIds).size) {
      throw Errors.BadRequestError("Retry attachments don't belong to that chat turn");
    }

    const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length);

    if (orderedSources.length > room) {
      throw Errors.BadRequestError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`);
    }

    let selectedBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);

    for (const source of orderedSources) {
      if (selectedBytes + source.size > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
        const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
        throw Errors.BadRequestError(`Attachments are too large — the combined limit is ${mb} MB`);
      }

      retrySources.push(source);
      selectedBytes += source.size;
    }
  }

  let existingMessageAttachmentRows: ExistingAttachmentSummary[] = [];

  if (existingMessage) {
    const existingAttachments = await loadAttachmentSummaries(db(), userId, userMessageId);
    existingMessageAttachmentRows = existingAttachments;

    if (
      !attachmentRequestMatchesExistingRows({
        fresh: attachments,
        retrySources,
        rows: existingAttachments,
      })
    ) {
      throw Errors.ConflictError("Message id already belongs to a different chat turn");
    }

    const existingRun = await findExistingChatTurnRun(
      db(),
      userId,
      userMessageId,
      createId("msg"),
      artifactTargetId,
    );

    if (existingRun) {
      await enqueueChatTurnRunBestEffort(existingRun.runId);

      return { outcome: "started", ...existingRun } satisfies TurnStartResponse;
    }
  }

  const now = new Date();
  const reuseExistingAttachmentRows = existingMessageAttachmentRows.length > 0;

  // Storage is verified later, in the transaction, under the orphan-cleanup lock.
  const freshAttachmentRows: NewChatAttachment[] = [];

  if (!reuseExistingAttachmentRows) {
    for (const [position, attachment] of attachments.entries()) {
      const degradation = await resolveAttachmentDegradation({
        storageKey: buildAttachmentKey({
          userId,
          threadId,
          messageId: userMessageId,
          attachmentId: attachment.id,
          fileName: attachment.name,
        }),
        mime: attachment.mime,
      });

      freshAttachmentRows.push(
        toAttachmentRow({
          userId: userId,
          threadId,
          messageId: userMessageId,
          attachment: { ...attachment, position },
          degradation,
        }),
      );
    }
  }

  // Retry re-attach (ADR-0065): copy the bytes under the new message key; nothing is re-uploaded.
  // Over the cap, reject; never drop an attachment silently.
  const retryAttachmentRows: NewChatAttachment[] = [];

  if (retrySources.length > 0 && !reuseExistingAttachmentRows) {
    for (const src of retrySources) {
      const newAttachmentId = createId("att");
      const position = freshAttachmentRows.length + retryAttachmentRows.length;

      const destKey = buildAttachmentKey({
        userId: userId,
        threadId,
        messageId: userMessageId,
        attachmentId: newAttachmentId,
        fileName: src.name,
      });

      try {
        await copyObject(src.storageKey, destKey);
        await schedulePendingUploadCleanup(userId, destKey);
      } catch (err) {
        console.warn("[chat] retry attachment copy failed:", toMessage(err));
        throw Errors.BadGatewayError("Couldn't copy the retry attachments. Try again.");
      }

      retryAttachmentRows.push(
        toAttachmentRow({
          userId: userId,
          threadId,
          messageId: userMessageId,
          attachment: {
            id: newAttachmentId,
            name: src.name,
            mime: src.mime,
            size: src.size,
            position,
          },
          degradation: isPdfContentType(src.mime)
            ? { kind: "pdf", text: src.degradedText }
            : { kind: "image" },
        }),
      );
    }
  }

  if (
    content.length === 0 &&
    freshAttachmentRows.length === 0 &&
    retryAttachmentIds.length > 0 &&
    retryAttachmentRows.length === 0 &&
    !reuseExistingAttachmentRows
  ) {
    throw Errors.BadRequestError("No retryable attachments were found");
  }

  const attachmentRows = [...freshAttachmentRows, ...retryAttachmentRows];
  assertAttachmentBatchAllowed(attachmentRows);

  const assistantMessageId = createId("msg");
  let acceptedFreshAttachmentBytes = 0;

  const result = await db().transaction<TurnStartResponse>(async (tx) => {
    if (!thread) {
      await tx
        .insert(chatThreads)
        .values({ id: threadId, userId: userId, lastMessageAt: now })
        .onConflictDoNothing();
    }

    // Idempotent: the client mutator minted this id.
    await tx
      .insert(chatMessages)
      .values({
        id: userMessageId,
        userId: userId,
        threadId,
        role: "user",
        content,
        status: "complete",
      })
      .onConflictDoNothing();

    const writtenMessages = await tx
      .select({
        userId: chatMessages.userId,
        threadId: chatMessages.threadId,
        content: chatMessages.content,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, userMessageId))
      .for("update")
      .limit(1);

    const writtenMessage = writtenMessages[0];

    if (
      !writtenMessage ||
      writtenMessage.userId !== userId ||
      writtenMessage.threadId !== threadId
    ) {
      throw Errors.ConflictError("Message id already belongs to another chat message");
    }

    if (writtenMessage.content !== content) {
      throw Errors.ConflictError("Message id already belongs to a different chat turn");
    }

    const currentAttachments = await loadAttachmentSummaries(tx, userId, userMessageId);

    if (
      currentAttachments.length > 0 &&
      !attachmentRequestMatchesExistingRows({
        fresh: attachments,
        retrySources,
        rows: currentAttachments,
      })
    ) {
      throw Errors.ConflictError("Message id already belongs to a different chat turn");
    }

    // The lock orders this against cleanup: it deletes first and this check fails, or it sees the row.
    if (attachmentRows.length > 0 && currentAttachments.length === 0) {
      await lockChatStorageKeys(
        tx,
        attachmentRows.map((row) => row.storageKey),
      );

      for (const row of attachmentRows) {
        await assertStoredAttachmentReady({
          storageKey: row.storageKey,
          mime: row.mime,
          size: row.size,
        });
      }

      await tx.insert(chatAttachments).values(attachmentRows).onConflictDoNothing();
      const writtenAttachments = await loadAttachmentSummaries(tx, userId, userMessageId);

      if (!sameInsertedAttachmentRows(attachmentRows, writtenAttachments)) {
        throw Errors.ConflictError("Message id already belongs to a different chat turn");
      }

      acceptedFreshAttachmentBytes = freshAttachmentRows.reduce((sum, row) => sum + row.size, 0);
    }

    // An image-only opener takes its title from the first attachment name.
    const titleSeed =
      content.length > 0
        ? content.slice(0, TITLE_MAX_CHARS)
        : (attachmentRows[0]?.name ?? "").slice(0, TITLE_MAX_CHARS);

    await tx
      .update(chatThreads)
      .set({
        title: sql`coalesce(${chatThreads.title}, ${titleSeed})`,
        lastMessageAt: now,
        rowVersion: sql`${chatThreads.rowVersion} + 1`,
      })
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));

    try {
      // A SAVEPOINT: a unique violation aborts the whole Postgres transaction, and
      // the recovery reads in the catch would then fail with 25P02.
      const { runId } = await persistChatTurnRunInTx(tx, {
        userId: userId,
        workflowSlug: CHAT_TURN_WORKFLOW_SLUG,
        trigger: { kind: "manual" },
        occurrence: {
          kind: "manual",
          requestId: userMessageId,
        },
        metadata: {
          threadId,
          assistantMessageId,
          userMessageId: userMessageId,
          tier: tier ?? "standard",
          ...(artifactTargetId !== undefined ? { artifactTargetId } : {}),
        },
      });

      return { outcome: "started", runId, assistantMessageId };
    } catch (err) {
      // Two unique indexes can trip here. Branch on which one.
      const constraint = uniqueViolationConstraint(err);

      if (constraint === null) throw err;

      // A different message won the race for this thread (#488).
      if (constraint === CHAT_THREAD_ACTIVE_RUN_INDEX) {
        const blockingRunId = await findBlockingChatTurnRun(tx, userId, threadId, userMessageId);

        return { outcome: "busy", runId: blockingRunId };
      }

      // A double submit of the same message: return the existing run.
      const existingRun = await findExistingChatTurnRun(
        tx,
        userId,
        userMessageId,
        assistantMessageId,
        artifactTargetId,
      );

      return existingRun
        ? { outcome: "started", ...existingRun }
        : { outcome: "started", runId: null, assistantMessageId };
    }
  });

  if (attachmentRows.length > 0) {
    try {
      emitReplicachePokes([userId]);
    } catch (err) {
      console.warn("[chat] attachment poke failed:", toMessage(err));
    }
  }

  await releasePendingUploadBudget(userId, acceptedFreshAttachmentBytes);

  // A busy outcome points at another turn's run; do not enqueue it again.
  if (result.outcome === "started") {
    await enqueueChatTurnRunBestEffort(result.runId);
  }

  return result;
}
