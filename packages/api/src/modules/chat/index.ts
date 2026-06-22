import { transcribeAudio } from "@alfred/ai";
import {
  getPath,
  isNonEmptyString,
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
import { authMacro } from "../../middleware/auth";
import {
  BadGatewayError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../middleware/errors";
import { createRun, enqueueRun, getRun, isUniqueViolation } from "../agent/index";
import { CHAT_TURN_WORKFLOW_SLUG } from "../agent/workflows/chat-turn";
import {
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
  signedUploadUrl,
  writeObject,
} from "./storage";
import { requestChatStop } from "./stop-signal";

const TITLE_MAX_CHARS = 80;

/**
 * Chat turn surface (streaming-chat plan). The composer first persists the
 * user's message + thread via Replicache mutators (optimistic, multi-device),
 * then calls this to kick the agent. To avoid a mutator-push vs run-start
 * race, this endpoint *also* upserts the user message (idempotent on the
 * client-minted id) so the chat-turn workflow's transcript always sees it.
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
         * Mint a direct-to-bucket upload URL for a chat attachment (ADR-0065).
         * The browser PUTs the bytes straight to the bucket — the server never
         * proxies the file. No DB row is written here: the durable
         * `chat_attachments` row is created at send time (the turn endpoint),
         * once the user message it references exists. The storage key is built
         * server-side from the caller's id + the client-supplied ids, so the
         * client can't point the upload outside its own `chat/{userId}/…` prefix.
         */
        "/attachments/sign",
        async ({ body, user }) => {
          if (!isStorageConfigured()) {
            throw new ServiceUnavailableError(
              "File uploads aren't configured — set the CHAT_S3_* env vars on the server.",
            );
          }
          const policy = assertUploadAllowed(body.mime, body.size);
          const storageKey = buildAttachmentKey({
            userId: user.id,
            threadId: body.threadId,
            messageId: body.messageId,
            attachmentId: body.attachmentId,
            fileName: body.name,
          });
          try {
            const upload = await signedUploadUrl(storageKey, body.mime, policy.maxBytes);
            return { storageKey, upload };
          } catch (err) {
            console.error("[chat] sign upload failed:", toMessage(err));
            throw new BadGatewayError("Couldn't prepare the upload. Try again.");
          }
        },
        {
          body: t.Object({
            threadId: t.String({ minLength: 1, maxLength: 120 }),
            messageId: t.String({ minLength: 1, maxLength: 100 }),
            attachmentId: t.String({ minLength: 1, maxLength: 100 }),
            name: t.String({ minLength: 1, maxLength: 255 }),
            mime: t.String({ minLength: 1, maxLength: 255 }),
            size: t.Integer({ minimum: 1 }),
          }),
        },
      )
      .post(
        /**
         * Server-proxied attachment upload (ADR-0065). The direct-to-bucket
         * presigned-POST path (the `/sign` route) is correct, but Railway's
         * storage provider serves no CORS `Access-Control-Allow-Origin` header,
         * so a browser PUT/POST to the bucket is blocked. Instead the client
         * posts the bytes here (same-origin, already CORS-cleared like the rest
         * of the API) and we relay them to the bucket. Same policy gate and
         * server-built key as `/sign`, so the turn endpoint rebuilds an
         * identical key. No DB row is written here — that happens at send time.
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
          const bytes = new Uint8Array(await file.arrayBuffer());
          assertPassThroughImageBytes(bytes, body.mime);
          try {
            await writeObject(storageKey, bytes, body.mime);
            return { storageKey };
          } catch (err) {
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
          // A turn must carry text or at least one attachment — a fresh upload
          // or a re-attached one from a retry (image-only sends are valid: the
          // prompt is the image).
          if (content.length === 0 && attachments.length === 0 && retryAttachmentIds.length === 0) {
            throw new BadRequestError("A message must have text or an attachment");
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

          // Reject a reused message id before storage verification/copies or a
          // new thread insert can leave side effects. The post-insert check below
          // still handles the race where another request claims the id first.
          const existingMessages = await db()
            .select({ userId: chatMessages.userId, threadId: chatMessages.threadId })
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

          const now = new Date();

          // Build and verify the fresh attachment rows before any durable chat
          // writes. A ready row is only created when the canonical object exists
          // and its bytes match the declared pass-through image type.
          const freshAttachmentRows: (typeof chatAttachments.$inferInsert)[] = [];
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

          // Faithful retry (ADR-0065): re-attach a prior message's images by
          // copying their bytes under this new message's key prefix, then
          // writing fresh rows (which sync back via pull). The bytes already
          // exist, so nothing is re-uploaded — the client sent only source ids.
          // Ownership-scoped to this user; a per-object copy failure drops just
          // that attachment. Honors the combined per-message cap.
          const retryAttachmentRows: (typeof chatAttachments.$inferInsert)[] = [];
          if (retryAttachmentIds.length > 0 && storageConfigured) {
            const sources = await db()
              .select({
                storageKey: chatAttachments.storageKey,
                name: chatAttachments.name,
                mime: chatAttachments.mime,
                size: chatAttachments.size,
                position: chatAttachments.position,
              })
              .from(chatAttachments)
              .where(
                and(
                  inArray(chatAttachments.id, retryAttachmentIds),
                  eq(chatAttachments.userId, user.id),
                  eq(chatAttachments.status, "ready"),
                ),
              )
              .orderBy(
                asc(chatAttachments.position),
                asc(chatAttachments.createdAt),
                asc(chatAttachments.id),
              );
            const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachments.length);
            for (const src of sources.slice(0, room)) {
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
              } catch (err) {
                console.warn("[chat] retry attachment copy failed:", toMessage(err));
                continue;
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
            retryAttachmentRows.length === 0
          ) {
            throw new BadRequestError("No retryable attachments were found");
          }

          if (!thread) {
            await db()
              .insert(chatThreads)
              .values({ id: threadId, userId: user.id, lastMessageAt: now })
              .onConflictDoNothing();
          }

          // Idempotent user-message upsert (same id the client mutator minted).
          await db()
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

          const writtenMessages = await db()
            .select({ userId: chatMessages.userId, threadId: chatMessages.threadId })
            .from(chatMessages)
            .where(eq(chatMessages.id, body.userMessageId))
            .limit(1);
          const writtenMessage = writtenMessages[0];
          if (
            !writtenMessage ||
            writtenMessage.userId !== user.id ||
            writtenMessage.threadId !== threadId
          ) {
            throw new ConflictError("Message id already belongs to another chat message");
          }

          const attachmentRows = [...freshAttachmentRows, ...retryAttachmentRows];
          // Persist attachment rows now that the owned message they reference
          // exists. Keys were rebuilt and verified server-side above.
          if (attachmentRows.length > 0) {
            await db().insert(chatAttachments).values(attachmentRows).onConflictDoNothing();
          }

          // Derive a title from the first message; bump the thread to the top.
          // Fall back to the first attachment's name for an image-only opener
          // (a fresh upload, or a re-attached image on a retry).
          const titleSeed =
            content.length > 0
              ? content.slice(0, TITLE_MAX_CHARS)
              : (attachmentRows[0]?.name ?? "").slice(0, TITLE_MAX_CHARS);
          await db()
            .update(chatThreads)
            .set({
              title: sql`coalesce(${chatThreads.title}, ${titleSeed})`,
              lastMessageAt: now,
              rowVersion: sql`${chatThreads.rowVersion} + 1`,
            })
            .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, user.id)));

          const assistantMessageId = createId("msg");
          try {
            const { runId } = await createRun({
              userId: user.id,
              workflowSlug: CHAT_TURN_WORKFLOW_SLUG,
              trigger: { kind: "manual" },
              metadata: {
                threadId,
                assistantMessageId,
                userMessageId: body.userMessageId,
                tier: body.tier ?? "standard",
              },
            });
            await enqueueRun(runId);
            return { runId, assistantMessageId };
          } catch (err) {
            // The chat-turn workflow is a singleton on userMessageId — a
            // double-submit / retry collides on the partial unique index. Treat
            // that as success: a run for this exact turn is already in flight,
            // so return it instead of spawning a duplicate reply.
            if (!isUniqueViolation(err)) throw err;
            const active = await db()
              .select({ id: agentRuns.id, metadata: agentRuns.metadata })
              .from(agentRuns)
              .where(
                and(
                  eq(agentRuns.userId, user.id),
                  eq(agentRuns.workflowSlug, CHAT_TURN_WORKFLOW_SLUG),
                  eq(agentRuns.dedupKey, `chat:${body.userMessageId}`),
                ),
              )
              .limit(1);
            const existing = active[0];
            const existingAssistantId = getPath(existing?.metadata, "assistantMessageId");
            const existingMessageId = isNonEmptyString(existingAssistantId)
              ? existingAssistantId
              : assistantMessageId;
            return { runId: existing?.id ?? null, assistantMessageId: existingMessageId };
          }
        },
        {
          params: t.Object({ threadId: t.String({ minLength: 1, maxLength: 120 }) }),
          body: t.Object({
            userMessageId: t.String({ minLength: 1, maxLength: 100 }),
            // May be empty when the turn carries an attachment (image-only send).
            content: t.String({ minLength: 0, maxLength: 100_000 }),
            // Model tier from the composer's picker; `getChatModel` maps it.
            tier: t.Optional(t.Union([t.Literal("standard"), t.Literal("deep")])),
            // Files uploaded via /attachments/sign during composition. The id
            // must match the one used to sign (the storage key is rebuilt from it).
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
          }),
        },
      ),
  );
