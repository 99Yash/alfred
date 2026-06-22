import { transcribeAudio } from "@alfred/ai";
import {
  getPath,
  isNonEmptyString,
  MAX_ATTACHMENT_BYTES_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  toMessage,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { createId } from "@alfred/db/helpers";
import { agentRuns, chatAttachments, chatMessages, chatThreads } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { emitReplicachePokes } from "../../events/replicache-events";
import { authMacro } from "../../middleware/auth";
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
} from "../../middleware/errors";
import { createCacheRedisConnection } from "../../queue/connection";
import { createRun, enqueueRun, getRun, isUniqueViolation } from "../agent/index";
import { CHAT_TURN_WORKFLOW_SLUG } from "../agent/workflows/chat-turn";
import { enqueuePendingUploadCleanup } from "../integrations/queue";
import {
  assertAttachmentBatchAllowed,
  assertPassThroughImageBytes,
  assertStoredAttachmentReady,
  assertUploadAllowed,
  toAttachmentRow,
} from "./attachments";
import {
  attachmentUrl,
  buildAttachmentKey,
  copyObject,
  isStorageConfigured,
  objectExists,
  writeObject,
} from "./storage";
import { requestChatStop } from "./stop-signal";

const TITLE_MAX_CHARS = 80;
const ATTACHMENT_UPLOAD_RATE_LIMIT_SECONDS = 60;
const ATTACHMENT_UPLOAD_RATE_LIMIT_COUNT = 30;
const ATTACHMENT_UPLOAD_QUOTA_TTL_SECONDS = 60 * 60;
const MAX_PENDING_ATTACHMENT_UPLOAD_BYTES = MAX_ATTACHMENT_BYTES_PER_MESSAGE * 4;
let attachmentUploadRateRedis: ReturnType<typeof createCacheRedisConnection> | undefined;

type DbTransaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type DbExecutor = ReturnType<typeof db> | DbTransaction;
type AttachmentInsertRow = typeof chatAttachments.$inferInsert;
type ExistingAttachmentSummary = Pick<
  typeof chatAttachments.$inferSelect,
  "id" | "name" | "mime" | "size" | "position"
>;
type RetryAttachmentSource = Pick<
  typeof chatAttachments.$inferSelect,
  "id" | "storageKey" | "name" | "mime" | "size"
>;
interface FreshAttachmentDescriptor {
  id: string;
  name: string;
  mime: string;
  size: number;
  position?: number;
}

export interface ExistingChatTurnRun {
  runId: string | null;
  assistantMessageId: string;
}

function getAttachmentUploadRateRedis(): ReturnType<typeof createCacheRedisConnection> {
  attachmentUploadRateRedis ??= createCacheRedisConnection();
  return attachmentUploadRateRedis;
}

async function incrementUploadCounter(
  key: string,
  amount: number,
  ttlSeconds: number,
): Promise<number> {
  const redis = getAttachmentUploadRateRedis();
  const value = amount === 1 ? await redis.incr(key) : await redis.incrby(key, amount);
  if (value === amount) await redis.expire(key, ttlSeconds);
  return value;
}

async function releasePendingUploadBudget(userId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  try {
    const redis = getAttachmentUploadRateRedis();
    const key = `quota:chat:attachments:pending-bytes:${userId}`;
    const value = await redis.decrby(key, amount);
    if (value <= 0) await redis.del(key);
  } catch (err) {
    console.warn("[chat] pending attachment quota release failed:", toMessage(err));
  }
}

async function assertAttachmentUploadRateAllowed(userId: string): Promise<void> {
  try {
    const bucket = Math.floor(Date.now() / (ATTACHMENT_UPLOAD_RATE_LIMIT_SECONDS * 1000));
    const rateKey = `rate:chat:attachments:upload:${userId}:${bucket}`;
    const rateCount = await incrementUploadCounter(
      rateKey,
      1,
      ATTACHMENT_UPLOAD_RATE_LIMIT_SECONDS,
    );
    if (rateCount > ATTACHMENT_UPLOAD_RATE_LIMIT_COUNT) {
      throw new TooManyRequestsError("Too many attachment uploads. Try again in a minute.");
    }
  } catch (err) {
    if (err instanceof TooManyRequestsError) throw err;
    console.warn("[chat] attachment upload rate limit unavailable:", toMessage(err));
    throw new ServiceUnavailableError("Attachment upload quota is unavailable. Try again.");
  }
}

async function assertAttachmentUploadBudgetAllowed(args: {
  userId: string;
  threadId: string;
  messageId: string;
  size: number;
}): Promise<void> {
  try {
    const messageKey = `quota:chat:attachments:message:${args.userId}:${args.threadId}:${args.messageId}`;
    const messageCount = await incrementUploadCounter(
      `${messageKey}:count`,
      1,
      ATTACHMENT_UPLOAD_QUOTA_TTL_SECONDS,
    );
    const messageBytes = await incrementUploadCounter(
      `${messageKey}:bytes`,
      args.size,
      ATTACHMENT_UPLOAD_QUOTA_TTL_SECONDS,
    );
    if (messageCount > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new BadRequestError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`);
    }
    if (messageBytes > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
      const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
      throw new BadRequestError(`Attachments are too large — the combined limit is ${mb} MB`);
    }

    const pendingBytes = await incrementUploadCounter(
      `quota:chat:attachments:pending-bytes:${args.userId}`,
      args.size,
      ATTACHMENT_UPLOAD_QUOTA_TTL_SECONDS,
    );
    if (pendingBytes > MAX_PENDING_ATTACHMENT_UPLOAD_BYTES) {
      await releasePendingUploadBudget(args.userId, args.size);
      throw new TooManyRequestsError("Too many pending attachment uploads. Try again later.");
    }
  } catch (err) {
    if (err instanceof BadRequestError || err instanceof TooManyRequestsError) throw err;
    console.warn("[chat] attachment upload quota unavailable:", toMessage(err));
    throw new ServiceUnavailableError("Attachment upload quota is unavailable. Try again.");
  }
}

async function findExistingChatTurnRun(
  ex: DbExecutor,
  userId: string,
  userMessageId: string,
  fallbackAssistantMessageId: string,
): Promise<ExistingChatTurnRun | null> {
  const active = await ex
    .select({ id: agentRuns.id, metadata: agentRuns.metadata })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.workflowSlug, CHAT_TURN_WORKFLOW_SLUG),
        eq(agentRuns.dedupKey, `chat:${userMessageId}`),
      ),
    )
    .limit(1);
  const existing = active[0];
  if (!existing) return null;
  const existingAssistantId = getPath(existing.metadata, "assistantMessageId");
  return {
    runId: existing.id,
    assistantMessageId: isNonEmptyString(existingAssistantId)
      ? existingAssistantId
      : fallbackAssistantMessageId,
  };
}

function freshAttachmentRowsMatchSubset(
  inputs: readonly FreshAttachmentDescriptor[],
  rows: readonly ExistingAttachmentSummary[],
): boolean {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const [index, input] of inputs.entries()) {
    const row = rowsById.get(input.id);
    const position = input.position ?? index;
    if (!row) return false;
    if (
      row.name !== input.name ||
      row.mime !== input.mime ||
      row.size !== input.size ||
      row.position !== position
    ) {
      return false;
    }
  }
  return true;
}

function attachmentRequestMatchesExistingRows(args: {
  fresh: readonly FreshAttachmentDescriptor[];
  retrySources: readonly RetryAttachmentSource[];
  rows: readonly ExistingAttachmentSummary[];
}): boolean {
  const expectedCount = args.fresh.length + args.retrySources.length;
  if (args.rows.length !== expectedCount) return false;
  if (args.fresh.length > 0 && !freshAttachmentRowsMatchSubset(args.fresh, args.rows)) {
    return false;
  }
  const freshIds = new Set(args.fresh.map((input) => input.id));
  const retryRows = args.rows.filter((row) => !freshIds.has(row.id));
  if (retryRows.length !== args.retrySources.length) return false;
  for (const [index, source] of args.retrySources.entries()) {
    const row = retryRows[index];
    const position = args.fresh.length + index;
    if (!row) return false;
    if (
      row.name !== source.name ||
      row.mime !== source.mime ||
      row.size !== source.size ||
      row.position !== position
    ) {
      return false;
    }
  }
  return true;
}

function sameInsertedAttachmentRows(
  expected: readonly AttachmentInsertRow[],
  rows: readonly ExistingAttachmentSummary[],
): boolean {
  if (expected.length !== rows.length) return false;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  for (const expectedRow of expected) {
    if (!expectedRow.id) return false;
    const row = rowsById.get(expectedRow.id);
    if (!row) return false;
    if (
      row.name !== expectedRow.name ||
      row.mime !== expectedRow.mime ||
      row.size !== expectedRow.size ||
      row.position !== expectedRow.position
    ) {
      return false;
    }
  }
  return true;
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

async function schedulePendingUploadCleanup(userId: string, storageKey: string): Promise<void> {
  try {
    await enqueuePendingUploadCleanup(userId, storageKey);
  } catch (err) {
    console.warn("[chat] pending upload cleanup enqueue failed:", toMessage(err));
  }
}

async function enqueueChatTurnRunBestEffort(runId: string | null | undefined): Promise<void> {
  if (!runId) return;
  try {
    await enqueueRun(runId);
  } catch (err) {
    // `createRun` persisted a pending row; the agent worker's resume sweep
    // re-enqueues pending/runnable rows, so do not tell the client the send
    // failed after the chat turn itself is already durable.
    console.warn("[chat] run enqueue failed; resume sweep will recover:", toMessage(err));
  }
}

/**
 * Chat turn surface (streaming-chat plan). The composer uploads any attachment
 * bytes first, then this endpoint durably writes the user's accepted turn and
 * kicks the agent. The client mirrors the accepted turn into Replicache only
 * after this route acks, so the server is the canonical send boundary.
 *
 * The reply streams over the SSE event bus (`chat.delta` / `chat.tool` /
 * `chat.message`); the durable assistant message is written by the worker on
 * completion. Returns the run id + the assistant message id the client should
 * expect on the stream.
 */
/** OpenAI's transcription endpoint caps uploads at 25 MB; mirror it here. */
const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

export const chatRoutes = new Elysia({ prefix: "/api/chat", normalize: "typebox" })
  .use(authMacro)
  .guard({ auth: true }, (app) =>
    app
      .post(
        /**
         * Composer voice input: the client records mic audio (webm/opus on
         * Chrome, mp4 on Safari) and posts the blob here; the transcript text
         * lands back in the editor. Synchronous because clips are short —
         * a composer dictation is seconds, not minutes.
         */
        "/transcribe",
        async ({ body }) => {
          if (!serverEnv().OPENAI_API_KEY) {
            throw new ServiceUnavailableError(
              "Voice transcription isn't configured — set OPENAI_API_KEY on the server.",
            );
          }
          const audio = new Uint8Array(await body.audio.arrayBuffer());
          if (audio.byteLength === 0) throw new BadRequestError("audio must not be empty");
          try {
            const { text } = await transcribeAudio(audio);
            return { text: text.trim() };
          } catch (err) {
            // Provider faults (bad audio container, clip too short, OpenAI
            // hiccup) are routine here — surface a retryable message instead
            // of a generic 500.
            console.warn("[chat] transcription failed:", toMessage(err));
            throw new BadGatewayError("Transcription failed. Try again.");
          }
        },
        {
          body: t.Object({
            audio: t.File({ maxSize: TRANSCRIBE_MAX_BYTES }),
          }),
        },
      )
      .post(
        /**
         * Server-proxied attachment upload (ADR-0065). The sole ingest path: a
         * browser can't PUT/POST direct-to-bucket because Railway's storage
         * provider serves no CORS `Access-Control-Allow-Origin` header. Instead
         * the client posts the bytes here (same-origin, already CORS-cleared like
         * the rest of the API) and we sniff + decode them before relaying to the
         * bucket — so anything that lands at a `chat/{userId}/…` key is already a
         * validated pass-through image, and send-time validation can trust it
         * with a cheap HEAD. The storage key is built server-side from the
         * caller's id, so the client can't point the upload outside its own
         * prefix. No DB row is written here — that happens at send time.
         */
        "/attachments/upload",
        async ({ body, user }) => {
          if (!isStorageConfigured()) {
            throw new ServiceUnavailableError(
              "File uploads aren't configured — set the CHAT_S3_* env vars on the server.",
            );
          }
          const file = body.file;
          // Validate the declared mime + actual byte size against the ingest
          // policy (per-type cap); the storage key is rebuilt server-side.
          assertUploadAllowed(body.mime, file.size);
          const storageKey = buildAttachmentKey({
            userId: user.id,
            threadId: body.threadId,
            messageId: body.messageId,
            attachmentId: body.attachmentId,
            fileName: body.name,
          });
          let reservedPendingBytes = 0;
          try {
            await assertAttachmentUploadRateAllowed(user.id);
            const existingRows = await db()
              .select({ id: chatAttachments.id })
              .from(chatAttachments)
              .where(eq(chatAttachments.id, body.attachmentId))
              .limit(1);
            if (existingRows[0]) {
              throw new ConflictError("Attachment already exists");
            }
            if (await objectExists(storageKey)) {
              await assertStoredAttachmentReady({
                storageKey,
                mime: body.mime,
                size: file.size,
              });
              await schedulePendingUploadCleanup(user.id, storageKey);
              return { storageKey };
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            await assertPassThroughImageBytes(bytes, body.mime);
            await assertAttachmentUploadBudgetAllowed({
              userId: user.id,
              threadId: body.threadId,
              messageId: body.messageId,
              size: file.size,
            });
            reservedPendingBytes = file.size;
            await writeObject(storageKey, bytes, body.mime);
            await schedulePendingUploadCleanup(user.id, storageKey);
            return { storageKey };
          } catch (err) {
            await releasePendingUploadBudget(user.id, reservedPendingBytes);
            if (
              err instanceof BadRequestError ||
              err instanceof ConflictError ||
              err instanceof TooManyRequestsError ||
              err instanceof ServiceUnavailableError
            )
              throw err;
            console.error("[chat] proxied upload failed:", toMessage(err));
            throw new BadGatewayError("Couldn't store the upload. Try again.");
          }
        },
        {
          body: t.Object({
            threadId: t.String({ minLength: 1, maxLength: 120 }),
            messageId: t.String({ minLength: 1, maxLength: 100 }),
            attachmentId: t.String({ minLength: 1, maxLength: 100 }),
            name: t.String({ minLength: 1, maxLength: 255 }),
            mime: t.String({ minLength: 1, maxLength: 255 }),
            file: t.File({ maxSize: MAX_ATTACHMENT_BYTES }),
          }),
        },
      )
      .get(
        /**
         * Auth-gated content proxy for an attachment's raw bytes (ADR-0065). The
         * synced `chat_attachments` row carries only display metadata — the
         * bucket is private, so the `<img>` points here and we 302 to a freshly
         * minted presigned GET. A stable, cookie-authed URL: no expiry to manage
         * client-side, and the raw bytes never become publicly addressable.
         */
        "/attachments/:id/content",
        async ({ params, user, set }) => {
          const rows = await db()
            .select({ storageKey: chatAttachments.storageKey })
            .from(chatAttachments)
            .where(and(eq(chatAttachments.id, params.id), eq(chatAttachments.userId, user.id)))
            .limit(1);
          const row = rows[0];
          if (!row) throw new NotFoundError("Attachment not found");
          if (!isStorageConfigured()) {
            throw new ServiceUnavailableError("File storage isn't configured");
          }
          set.status = 302;
          set.headers["Location"] = await attachmentUrl(row.storageKey);
          set.headers["Cache-Control"] = "private, max-age=300";
          return null;
        },
        { params: t.Object({ id: t.String({ minLength: 1, maxLength: 100 }) }) },
      )
      .post(
        /**
         * Stop an in-flight chat turn. Sets the Redis stop flag the chat-turn
         * workflow polls while draining the model stream; the worker then
         * finalizes whatever streamed so far through the normal completion
         * path (durable row + `chat.message completed`), so the client needs
         * no special reconciliation. Runs parked on an approval are excluded —
         * rejecting the approval is the existing path for those.
         */
        "/runs/:runId/stop",
        async ({ params, user }) => {
          const run = await getRun(params.runId, user.id);
          if (!run) throw new NotFoundError("Run not found");
          if (run.workflowSlug !== CHAT_TURN_WORKFLOW_SLUG) {
            throw new BadRequestError("Not a chat run");
          }
          if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
            throw new ConflictError("Run already finished");
          }
          if (run.status === "waiting") {
            throw new ConflictError("Run is awaiting approval — resolve the approval instead");
          }
          const recorded = await requestChatStop(params.runId);
          if (!recorded)
            throw new ServiceUnavailableError("Couldn't reach the stop channel — try again");
          return { ok: true };
        },
        { params: t.Object({ runId: t.String({ minLength: 1, maxLength: 120 }) }) },
      )
      .post(
        "/threads/:threadId/turn",
        async ({ params, body, user }) => {
          const threadId = params.threadId;
          const content = body.content.trim();
          const attachments = body.attachments ?? [];
          const retryAttachmentIds = body.retryAttachmentIds ?? [];
          const retryAttachmentMessageId = body.retryAttachmentMessageId ?? null;
          assertAttachmentBatchAllowed(attachments);
          // A turn must carry text or at least one attachment — a fresh upload
          // or a re-attached one from a retry (image-only sends are valid: the
          // prompt is the image).
          if (content.length === 0 && attachments.length === 0 && retryAttachmentIds.length === 0) {
            throw new BadRequestError("A message must have text or an attachment");
          }
          if (retryAttachmentIds.length > 0 && !retryAttachmentMessageId) {
            throw new BadRequestError("Retry attachments must include their source message");
          }
          const storageConfigured = isStorageConfigured();
          if ((attachments.length > 0 || retryAttachmentIds.length > 0) && !storageConfigured) {
            throw new ServiceUnavailableError("File storage isn't configured");
          }

          // Thread must be the caller's (or new). Reject cross-user posts.
          const existing = await db()
            .select({ userId: chatThreads.userId, title: chatThreads.title })
            .from(chatThreads)
            .where(eq(chatThreads.id, threadId))
            .limit(1);
          const thread = existing[0];
          if (thread && thread.userId !== user.id) {
            throw new NotFoundError("thread not found");
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
            .where(eq(chatMessages.id, body.userMessageId))
            .limit(1);
          const existingMessage = existingMessages[0];
          if (
            existingMessage &&
            (existingMessage.userId !== user.id || existingMessage.threadId !== threadId)
          ) {
            throw new ConflictError("Message id already belongs to another chat message");
          }
          if (existingMessage && existingMessage.content !== content) {
            throw new ConflictError("Message id already belongs to a different chat turn");
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
              })
              .from(chatAttachments)
              .innerJoin(chatMessages, eq(chatMessages.id, chatAttachments.messageId))
              .where(
                and(
                  inArray(chatAttachments.id, retryAttachmentIds),
                  eq(chatAttachments.userId, user.id),
                  eq(chatAttachments.messageId, retryAttachmentMessageId ?? ""),
                  eq(chatAttachments.status, "ready"),
                  eq(chatMessages.userId, user.id),
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
              throw new BadRequestError("Retry attachments don't belong to that chat turn");
            }
            const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length);
            if (orderedSources.length > room) {
              throw new BadRequestError(
                `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files`,
              );
            }
            let selectedBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
            for (const source of orderedSources) {
              if (selectedBytes + source.size > MAX_ATTACHMENT_BYTES_PER_MESSAGE) {
                const mb = Math.round(MAX_ATTACHMENT_BYTES_PER_MESSAGE / (1024 * 1024));
                throw new BadRequestError(
                  `Attachments are too large — the combined limit is ${mb} MB`,
                );
              }
              retrySources.push(source);
              selectedBytes += source.size;
            }
          }

          let existingMessageAttachmentRows: ExistingAttachmentSummary[] = [];
          if (existingMessage) {
            const existingAttachments = await loadAttachmentSummaries(
              db(),
              user.id,
              body.userMessageId,
            );
            existingMessageAttachmentRows = existingAttachments;
            if (
              !attachmentRequestMatchesExistingRows({
                fresh: attachments,
                retrySources,
                rows: existingAttachments,
              })
            ) {
              throw new ConflictError("Message id already belongs to a different chat turn");
            }
            const existingRun = await findExistingChatTurnRun(
              db(),
              user.id,
              body.userMessageId,
              createId("msg"),
            );
            if (existingRun) {
              await enqueueChatTurnRunBestEffort(existingRun.runId);
              return existingRun;
            }
          }

          const now = new Date();
          const reuseExistingAttachmentRows = existingMessageAttachmentRows.length > 0;

          // Build and verify the fresh attachment rows before any durable chat
          // writes. A ready row is only created when the canonical object exists
          // and its bytes match the declared pass-through image type.
          const freshAttachmentRows: AttachmentInsertRow[] = [];
          if (!reuseExistingAttachmentRows) {
            for (const [position, attachment] of attachments.entries()) {
              const row = toAttachmentRow({
                userId: user.id,
                threadId,
                messageId: body.userMessageId,
                attachment: { ...attachment, position },
              });
              await assertStoredAttachmentReady({
                storageKey: row.storageKey,
                mime: row.mime,
                size: row.size,
              });
              freshAttachmentRows.push(row);
            }
          }

          // Faithful retry (ADR-0065): re-attach a prior message's images by
          // copying their bytes under this new message's key prefix, then
          // writing fresh rows (which sync back via pull). The bytes already
          // exist, so nothing is re-uploaded — the client sent only source ids.
          // Ownership-scoped to this user. Honors the combined per-message cap,
          // and rejects instead of silently dropping requested images.
          const retryAttachmentRows: AttachmentInsertRow[] = [];
          if (retrySources.length > 0 && !reuseExistingAttachmentRows) {
            for (const src of retrySources) {
              const newAttachmentId = createId("att");
              const position = freshAttachmentRows.length + retryAttachmentRows.length;
              const destKey = buildAttachmentKey({
                userId: user.id,
                threadId,
                messageId: body.userMessageId,
                attachmentId: newAttachmentId,
                fileName: src.name,
              });
              try {
                await copyObject(src.storageKey, destKey);
                await schedulePendingUploadCleanup(user.id, destKey);
              } catch (err) {
                console.warn("[chat] retry attachment copy failed:", toMessage(err));
                throw new BadGatewayError("Couldn't copy the retry attachments. Try again.");
              }
              retryAttachmentRows.push(
                toAttachmentRow({
                  userId: user.id,
                  threadId,
                  messageId: body.userMessageId,
                  attachment: {
                    id: newAttachmentId,
                    name: src.name,
                    mime: src.mime,
                    size: src.size,
                    position,
                  },
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
            throw new BadRequestError("No retryable attachments were found");
          }

          const attachmentRows = [...freshAttachmentRows, ...retryAttachmentRows];
          assertAttachmentBatchAllowed(attachmentRows);

          const assistantMessageId = createId("msg");
          let acceptedFreshAttachmentBytes = 0;
          const result = await db().transaction<ExistingChatTurnRun>(async (tx) => {
            if (!thread) {
              await tx
                .insert(chatThreads)
                .values({ id: threadId, userId: user.id, lastMessageAt: now })
                .onConflictDoNothing();
            }

            // Idempotent user-message upsert (same id the client mutator minted).
            await tx
              .insert(chatMessages)
              .values({
                id: body.userMessageId,
                userId: user.id,
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
              .where(eq(chatMessages.id, body.userMessageId))
              .for("update")
              .limit(1);
            const writtenMessage = writtenMessages[0];
            if (
              !writtenMessage ||
              writtenMessage.userId !== user.id ||
              writtenMessage.threadId !== threadId
            ) {
              throw new ConflictError("Message id already belongs to another chat message");
            }
            if (writtenMessage.content !== content) {
              throw new ConflictError("Message id already belongs to a different chat turn");
            }

            const currentAttachments = await loadAttachmentSummaries(
              tx,
              user.id,
              body.userMessageId,
            );
            if (
              currentAttachments.length > 0 &&
              !attachmentRequestMatchesExistingRows({
                fresh: attachments,
                retrySources,
                rows: currentAttachments,
              })
            ) {
              throw new ConflictError("Message id already belongs to a different chat turn");
            }

            // Persist attachment rows now that the owned message they reference
            // exists. Keys were rebuilt and verified server-side above.
            if (attachmentRows.length > 0 && currentAttachments.length === 0) {
              await tx.insert(chatAttachments).values(attachmentRows).onConflictDoNothing();
              const writtenAttachments = await loadAttachmentSummaries(
                tx,
                user.id,
                body.userMessageId,
              );
              if (!sameInsertedAttachmentRows(attachmentRows, writtenAttachments)) {
                throw new ConflictError("Message id already belongs to a different chat turn");
              }
              acceptedFreshAttachmentBytes = freshAttachmentRows.reduce(
                (sum, row) => sum + row.size,
                0,
              );
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
              .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, user.id)));

            try {
              const { runId } = await createRun(
                {
                  userId: user.id,
                  workflowSlug: CHAT_TURN_WORKFLOW_SLUG,
                  trigger: { kind: "manual" },
                  metadata: {
                    threadId,
                    assistantMessageId,
                    userMessageId: body.userMessageId,
                    tier: body.tier ?? "standard",
                  },
                },
                tx,
              );
              return { runId, assistantMessageId };
            } catch (err) {
              // The chat-turn workflow is a singleton on userMessageId — a
              // double-submit / retry collides on the partial unique index. Treat
              // that as success: a run for this exact turn is already in flight,
              // so return it instead of spawning a duplicate reply.
              if (!isUniqueViolation(err)) throw err;
              const existingRun = await findExistingChatTurnRun(
                tx,
                user.id,
                body.userMessageId,
                assistantMessageId,
              );
              return existingRun ?? { runId: null, assistantMessageId };
            }
          });
          if (attachmentRows.length > 0) {
            try {
              emitReplicachePokes([user.id]);
            } catch (err) {
              console.warn("[chat] attachment poke failed:", toMessage(err));
            }
          }
          await releasePendingUploadBudget(user.id, acceptedFreshAttachmentBytes);
          await enqueueChatTurnRunBestEffort(result.runId);
          return result;
        },
        {
          params: t.Object({ threadId: t.String({ minLength: 1, maxLength: 120 }) }),
          body: t.Object({
            userMessageId: t.String({ minLength: 1, maxLength: 100 }),
            // May be empty when the turn carries an attachment (image-only send).
            content: t.String({ minLength: 0, maxLength: 100_000 }),
            // Model tier from the composer's picker; `getChatModel` maps it.
            tier: t.Optional(t.Union([t.Literal("standard"), t.Literal("deep")])),
            // Files uploaded via /attachments/upload during composition. The id
            // must match the upload's (the storage key is rebuilt from it).
            attachments: t.Optional(
              t.Array(
                t.Object({
                  id: t.String({ minLength: 1, maxLength: 100 }),
                  name: t.String({ minLength: 1, maxLength: 255 }),
                  mime: t.String({ minLength: 1, maxLength: 255 }),
                  size: t.Integer({ minimum: 1 }),
                  position: t.Optional(
                    t.Integer({ minimum: 0, maximum: MAX_ATTACHMENTS_PER_MESSAGE - 1 }),
                  ),
                }),
                { maxItems: MAX_ATTACHMENTS_PER_MESSAGE },
              ),
            ),
            // Faithful retry (ADR-0065): source attachment ids from a prior
            // message whose bytes get copied under this new message's keys.
            // Server-side ownership-checked; the client never sends bytes here.
            retryAttachmentIds: t.Optional(
              t.Array(t.String({ minLength: 1, maxLength: 100 }), {
                maxItems: MAX_ATTACHMENTS_PER_MESSAGE,
              }),
            ),
            retryAttachmentMessageId: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
          }),
        },
      ),
  );
