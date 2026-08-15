/**
 * TRANSPORT ONLY. This file reads the request and writes the response; it takes
 * no decision that outlives either. Which run exists, which `chat_attachments`
 * rows exist, which bytes are stored, and which quota counters are consumed are
 * all decided in `@alfred/assistant/conversations` (ADR-0089), behind four entry
 * points: `startChatTurn`, `stopChatTurn`, `uploadChatAttachment`,
 * `resolveChatAttachmentContentUrl`. `/transcribe` carries no such decision.
 *
 * So this file imports no database address, no Redis address, no storage
 * function, and no `drizzle-orm` operator. That is not a style preference — it
 * is the rule that keeps product behavior out of the transport package, and
 * `packages/http/test/conversations-transport-only.test.ts` reads this file's
 * import set and fails on a forbidden one.
 *
 * `Errors.*` thrown below the seam still map to a status:
 * `packages/http/src/middleware/error-handler.ts` turns any `ApiError` into one.
 */
import { transcribeAudio } from "@alfred/ai";
import {
  Errors,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  toMessage,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { Elysia, t } from "elysia";

import {
  resolveChatAttachmentContentUrl,
  startChatTurn,
  stopChatTurn,
  uploadChatAttachment,
} from "@alfred/assistant/conversations";
import { authMacro } from "./middleware/auth";

/** OpenAI's transcription endpoint caps uploads at 25 MB; mirror it here. */
const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Chat turn surface (streaming-chat plan). The composer uploads any attachment
 * bytes first, then the turn endpoint durably writes the user's accepted turn
 * and kicks the agent. The client mirrors the accepted turn into Replicache only
 * after this route acks, so the server is the canonical send boundary.
 *
 * The reply streams over the SSE event bus (`chat.delta` / `chat.tool` /
 * `chat.message`); the durable assistant message is written by the worker on
 * completion. The turn route returns the run id + the assistant message id the
 * client should expect on the stream.
 */
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
            throw Errors.ServiceUnavailableError(
              "Voice transcription isn't configured — set OPENAI_API_KEY on the server.",
            );
          }
          const audio = new Uint8Array(await body.audio.arrayBuffer());
          if (audio.byteLength === 0) throw Errors.BadRequestError("audio must not be empty");
          try {
            const { text } = await transcribeAudio(audio);
            return { text: text.trim() };
          } catch (err) {
            // Provider faults (bad audio container, clip too short, OpenAI
            // hiccup) are routine here — surface a retryable message instead
            // of a generic 500.
            console.warn("[chat] transcription failed:", toMessage(err));
            throw Errors.BadGatewayError("Transcription failed. Try again.");
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
         * the rest of the API) and `uploadChatAttachment` sniffs + decodes them
         * before relaying to the bucket — so anything that lands at a
         * `chat/{userId}/…` key is already a validated pass-through image, and
         * send-time validation can trust it with a cheap HEAD. The storage key is
         * built server-side from the caller's id, so the client can't point the
         * upload outside its own prefix. No DB row is written here — that happens
         * at send time.
         *
         * `readBytes` is a thunk, not the bytes: the ingest path short circuits
         * on a duplicate row and on an object already at this key, and neither
         * arm reads the body. Passing `file.arrayBuffer()` eagerly would read
         * bytes those arms never read.
         */
        "/attachments/upload",
        async ({ body, user }) => {
          const file = body.file;
          return await uploadChatAttachment({
            userId: user.id,
            threadId: body.threadId,
            messageId: body.messageId,
            attachmentId: body.attachmentId,
            name: body.name,
            mime: body.mime,
            size: file.size,
            readBytes: async () => new Uint8Array(await file.arrayBuffer()),
          });
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
          set.headers["Location"] = await resolveChatAttachmentContentUrl(params.id, user.id);
          set.status = 302;
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
        async ({ params, user }) => await stopChatTurn(params.runId, user.id),
        { params: t.Object({ runId: t.String({ minLength: 1, maxLength: 120 }) }) },
      )
      .post(
        "/threads/:threadId/turn",
        async ({ params, body, user }) =>
          await startChatTurn({
            userId: user.id,
            threadId: params.threadId,
            userMessageId: body.userMessageId,
            content: body.content,
            tier: body.tier,
            artifactTargetId: body.artifactTargetId,
            attachments: body.attachments,
            retryAttachmentIds: body.retryAttachmentIds,
            retryAttachmentMessageId: body.retryAttachmentMessageId,
          }),
        {
          params: t.Object({ threadId: t.String({ minLength: 1, maxLength: 120 }) }),
          body: t.Object({
            userMessageId: t.String({ minLength: 1, maxLength: 100 }),
            // May be empty when the turn carries an attachment (image-only send).
            content: t.String({ minLength: 0, maxLength: 100_000 }),
            // Model tier from the composer's picker; `route` maps it.
            tier: t.Optional(t.Union([t.Literal("standard"), t.Literal("deep")])),
            // Selected by the artifact sidebar. Kept out of user prose and
            // ownership-scoped to this exact thread by `startChatTurn`.
            artifactTargetId: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
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
