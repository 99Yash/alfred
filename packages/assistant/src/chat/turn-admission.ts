import {
  Errors,
  getPath,
  isPdfContentType,
  isNonEmptyString,
  MAX_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_ATTACHMENTS_PER_MESSAGE,
  toMessage,
  type TurnKickResponse,
} from "@alfred/contracts";
import { db, type DbRoot, type DbTransaction } from "@alfred/db";
import { createId } from "@alfred/db/helpers";
import { uniqueViolationConstraint } from "@alfred/db/pg-errors";
import {
  agentRuns,
  artifacts,
  chatAttachments,
  chatMessages,
  chatThreads,
  runIsNotTerminal,
  CHAT_THREAD_ACTIVE_RUN_INDEX,
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
 * Turn admission: the decisions a chat send takes that outlive the response.
 * Which run exists, which `chat_attachments` rows exist, which bytes are copied,
 * and which quota counters are consumed are all settled here (ADR-0089).
 *
 * `packages/http/src/chat.ts` is the only transport in front of this.
 * It reads the request and writes the response; it takes no decision of its own.
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
        // Deliberately NOT `runIsNotTerminal`: this fronts the dedup-key index,
        // whose predicate excludes only failed/cancelled so a `completed` turn
        // still answers "already done" while a failed one stays retryable.
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
 * The id of a non-terminal chat-turn run already in flight on this thread for a
 * DIFFERENT user message, or `null` if the thread is free (or the only in-flight
 * run is this same message's — an idempotent retry, handled by
 * {@link findExistingChatTurnRun}). This is the per-thread concurrency guard
 * (#488): the client's "not streaming" submit gate is the ONLY thing stopping
 * overlapping runs today, and once the composer can auto-fire queued/steered
 * turns that gate no longer holds. The DB partial unique index
 * ({@link CHAT_THREAD_ACTIVE_RUN_INDEX}) is the race-safe boundary; this lookup
 * is the cheap fast path that rejects a busy thread before any attachment
 * copying or durable writes, and the recovery read after that index fires.
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
        eq(agentRuns.userId, userId),
        eq(agentRuns.workflowSlug, CHAT_TURN_WORKFLOW_SLUG),
        sql`${agentRuns.metadata} ->> 'threadId' = ${threadId}`,
        // Must match CHAT_THREAD_ACTIVE_RUN_INDEX's predicate exactly or this
        // fast path and the index it fronts disagree about which runs are
        // active. Both call `runIsNotTerminal`, so they can't.
        runIsNotTerminal(agentRuns.status),
      ),
    )
    .limit(1);
  const existing = active[0];
  if (!existing) return null;
  const runUserMessageId = getPath(existing.metadata, "userMessageId");
  // Same user message → this is a retry of the in-flight turn, not a busy
  // collision; the caller's idempotent existing-run path returns it as started.
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
    // `persistChatTurnRunInTx` persisted a pending row; the agent worker's resume sweep
    // re-enqueues pending/runnable rows, so do not tell the client the send
    // failed after the chat turn itself is already durable.
    console.warn("[chat] run enqueue failed; resume sweep will recover:", toMessage(err));
  }
}

/**
 * Request a stop on an in-flight chat turn: set the Redis stop flag the
 * chat-turn workflow polls while draining the model stream. Rejects a run that
 * is not a chat turn, already finished, or parked on an approval.
 */
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

/**
 * Admit a chat turn: validate the message + attachments, durably write the
 * accepted user turn, and kick the chat-turn run (createRun inside a SAVEPOINT
 * + best-effort enqueue). Owns the busy / reuse / started outcomes and the
 * per-thread concurrency guard. The route is the only transport in front of
 * this; `chat` owns turn admission per ADR-0089.
 */
export async function startChatTurn(input: StartChatTurnInput): Promise<TurnKickResponse> {
  const { userId, threadId, tier, artifactTargetId } = input;
  const userMessageId = input.userMessageId;
  const content = input.content.trim();
  const attachments = input.attachments ?? [];
  const retryAttachmentIds = input.retryAttachmentIds ?? [];
  const retryAttachmentMessageId = input.retryAttachmentMessageId ?? null;
  assertAttachmentBatchAllowed(attachments);
  // A turn must carry text or at least one attachment — a fresh upload
  // or a re-attached one from a retry (image-only sends are valid: the
  // prompt is the image).
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

  // Thread must be the caller's (or new). Reject cross-user posts.
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

  // Reject a divergent reused message id before storage verification/copies
  // or a new thread insert can leave side effects. Exact duplicate sends
  // return the already-created run when one exists.
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

  // Per-thread concurrency guard (#488): if a different turn is still in
  // flight on this thread, don't create a second run — return a typed
  // "busy" outcome so the client can keep this message queued and retry
  // when that run completes. Checked here, before any attachment copies
  // or durable writes, so a busy kick has no side effects. This is the
  // fast path; the DB partial unique index below is the race-safe
  // backstop for two kicks that both pass this check concurrently. An
  // exact duplicate submit (same user message) is NOT busy — it falls
  // through to the idempotent existing-run path.
  const blockingRunId = await findBlockingChatTurnRun(db(), userId, threadId, userMessageId);
  if (blockingRunId) {
    return { outcome: "busy", runId: blockingRunId } satisfies TurnKickResponse;
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
      return { outcome: "started", ...existingRun } satisfies TurnKickResponse;
    }
  }

  const now = new Date();
  const reuseExistingAttachmentRows = existingMessageAttachmentRows.length > 0;

  // Build the fresh attachment rows before any durable chat writes.
  // Storage verification runs inside the transaction after taking the
  // same per-key lock as orphan cleanup.
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

  // Faithful retry (ADR-0065): re-attach a prior message's attachments by
  // copying their bytes under this new message's key prefix, then writing fresh
  // rows (which sync back via pull). The bytes and any extracted text already
  // exist, so nothing is re-uploaded — the client sent only source ids.
  // Ownership-scoped to this user. Honors the combined per-message cap,
  // and rejects instead of silently dropping requested attachments.
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
  const result = await db().transaction<TurnKickResponse>(async (tx) => {
    if (!thread) {
      await tx
        .insert(chatThreads)
        .values({ id: threadId, userId: userId, lastMessageAt: now })
        .onConflictDoNothing();
    }

    // Idempotent user-message upsert (same id the client mutator minted).
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

    // Persist attachment rows now that the owned message they reference
    // exists. The lock makes the object check and durable row creation
    // atomic with respect to pending-upload cleanup: cleanup either
    // deletes first and this check fails, or observes the committed row.
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

    // Derive a title from the first message; bump the thread to the top.
    // Fall back to the first attachment's name for an image-only opener
    // (a fresh upload, or a re-attached image on a retry).
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
      // `persistChatTurnRunInTx` scopes the insert in a SAVEPOINT (nested tx)
      // so only the failed insert rolls back, leaving this outer tx alive for
      // the recovery SELECTs in the catch below. The chat-turn workflow is a
      // singleton on userMessageId, so a *concurrent* double-submit races here:
      // both requests pass the pre-tx existing-run check (neither run exists
      // yet), then one wins the `agent_runs` dedup-key insert and the other
      // hits a unique violation. A unique violation ABORTS the surrounding
      // Postgres transaction — recovering via `findExistingChatTurnRun(tx)` on
      // an aborted tx would fail with 25P02 and 500 the loser (data was fine —
      // one run — but the client saw an error); the savepoint is what keeps the
      // outer tx usable. Delivery is deferred to the post-commit kick at the
      // bottom of this function.
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
          artifactTargetId,
        },
      });
      return { outcome: "started", runId, assistantMessageId };
    } catch (err) {
      // A unique violation here means one of two invariants collided —
      // the savepoint rolled back only the failed insert, so the outer tx
      // is still alive to recover. Discriminate on WHICH index tripped.
      const constraint = uniqueViolationConstraint(err);
      if (constraint === null) throw err;
      // Per-thread guard (#488): a concurrent kick with a DIFFERENT user
      // message already has a run in flight on this thread and won the
      // race. This is the race-safe backstop for two kicks that both
      // passed the pre-tx `findBlockingChatTurnRun` check. Report busy —
      // no second run was created — carrying the in-flight run when it's
      // still visible so the client can await it before retrying.
      if (constraint === CHAT_THREAD_ACTIVE_RUN_INDEX) {
        const blockingRunId = await findBlockingChatTurnRun(tx, userId, threadId, userMessageId);
        return { outcome: "busy", runId: blockingRunId };
      }
      // Otherwise this is a same-user-message double-submit that collided
      // on the dedup index. Treat it as success: a run for this exact
      // turn is already in flight, so return it instead of spawning a
      // duplicate reply.
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
  // Only a started turn owns a run to enqueue. A busy outcome created no
  // run — the in-flight one it points at is already enqueued by its own
  // kick — so don't re-enqueue another turn's work.
  if (result.outcome === "started") {
    await enqueueChatTurnRunBestEffort(result.runId);
  }
  return result;
}
