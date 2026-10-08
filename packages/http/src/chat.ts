/**
 * Transport only: every decision lives in `@alfred/assistant/chat` (ADR-0089).
 * No DB, Redis, storage or `drizzle-orm` imports here;
 * `packages/http/test/chat-transport-only.test.ts` enforces it.
 */
import { MAX_TRANSCRIBE_AUDIO_BYTES, transcribeAudio, transcriptionConfigured } from "@alfred/ai";
import {
  Errors,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  toMessage,
} from "@alfred/contracts";
import { Elysia, t } from "elysia";

import {
  resolveChatAttachmentContentUrl,
  startChatTurn,
  stopChatTurn,
  uploadChatAttachment,
} from "@alfred/assistant/chat";
import { authMacro } from "./middleware/auth";
import { requireOnboarded } from "./middleware/onboarding";

/**
 * Chat turns. The client mirrors a turn into Replicache only after this route acks.
 * The reply streams over SSE; the worker writes the final assistant message.
 */
export const chatRoutes = new Elysia({ prefix: "/api/chat", normalize: "typebox" })
  .use(authMacro)
  .use(requireOnboarded)
  .guard({ auth: true, requireOnboarded: true }, (app) =>
    app
      .post(
        /** Composer dictation. Synchronous, because clips are seconds long. */
        "/transcribe",
        async ({ body }) => {
          if (!transcriptionConfigured()) {
            throw Errors.ServiceUnavailableError(
              "Voice transcription isn't configured — set the Cloudflare AI gateway or OPENAI_API_KEY on the server.",
            );
          }

          const audio = new Uint8Array(await body.audio.arrayBuffer());

          if (audio.byteLength === 0) throw Errors.BadRequestError("audio must not be empty");

          try {
            const { text } = await transcribeAudio(audio);

            return { text: text.trim() };
          } catch (err) {
            // Provider faults are routine, so return a retryable 502, not a 500.
            console.warn("[chat] transcription failed:", toMessage(err));
            throw Errors.BadGatewayError("Transcription failed. Try again.");
          }
        },
        {
          body: t.Object({
            audio: t.File({ maxSize: MAX_TRANSCRIBE_AUDIO_BYTES }),
          }),
        },
      )
      .post(
        /**
         * The only upload path (ADR-0065): the bucket sends no CORS headers.
         * The server builds the key from the caller's id. `readBytes` is lazy
         * because a duplicate upload never reads the body.
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
        /** A stable, cookie-authed URL that redirects to a fresh presigned GET (ADR-0065). */
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
        /** Stop a turn. The worker finalizes what streamed so far. Not for runs parked on an approval. */
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
            // From the artifact sidebar. `startChatTurn` scopes it to this thread.
            artifactTargetId: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
            // The id must match the upload's: the storage key is rebuilt from it.
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
            // Retry (ADR-0065): copy these prior attachments under the new message. Ownership is checked.
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
