import { transcribeAudio } from "@alfred/ai";
import { db } from "@alfred/db";
import { createId } from "@alfred/db/helpers";
import { agentRuns, chatMessages, chatThreads } from "@alfred/db/schemas";
import { serverEnv } from "@alfred/env/server";
import { and, eq, sql } from "drizzle-orm";
import { Elysia, status, t } from "elysia";
import { authMacro } from "../../middleware/auth";
import { createRun, enqueueRun, getRun, isUniqueViolation } from "../agent/index";
import { CHAT_TURN_WORKFLOW_SLUG } from "../agent/workflows/chat-turn";
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
            return status(503, {
              message: "Voice transcription isn't configured — set OPENAI_API_KEY on the server.",
            });
          }
          const audio = new Uint8Array(await body.audio.arrayBuffer());
          if (audio.byteLength === 0) return status(400, { message: "audio must not be empty" });
          try {
            const { text } = await transcribeAudio(audio);
            return { text: text.trim() };
          } catch (err) {
            // Provider faults (bad audio container, clip too short, OpenAI
            // hiccup) are routine here — surface a retryable message instead
            // of a generic 500.
            console.warn(
              "[chat] transcription failed:",
              err instanceof Error ? err.message : String(err),
            );
            return status(502, { message: "Transcription failed. Try again." });
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
          if (!run) return status(404, { message: "Run not found" });
          if (run.workflowSlug !== CHAT_TURN_WORKFLOW_SLUG) {
            return status(400, { message: "Not a chat run" });
          }
          if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
            return status(409, { message: "Run already finished" });
          }
          if (run.status === "waiting") {
            return status(409, {
              message: "Run is awaiting approval — resolve the approval instead",
            });
          }
          const recorded = await requestChatStop(params.runId);
          if (!recorded)
            return status(503, { message: "Couldn't reach the stop channel — try again" });
          return { ok: true };
        },
        { params: t.Object({ runId: t.String({ minLength: 1, maxLength: 120 }) }) },
      )
      .post(
        "/threads/:threadId/turn",
        async ({ params, body, user }) => {
          const threadId = params.threadId;
          const content = body.content.trim();
          if (content.length === 0) return status(400, { message: "content must not be empty" });

          // Thread must be the caller's (or new). Reject cross-user posts.
          const existing = await db()
            .select({ userId: chatThreads.userId, title: chatThreads.title })
            .from(chatThreads)
            .where(eq(chatThreads.id, threadId))
            .limit(1);
          const thread = existing[0];
          if (thread && thread.userId !== user.id) {
            return status(404, { message: "thread not found" });
          }

          const now = new Date();
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

          // Derive a title from the first message; bump the thread to the top.
          await db()
            .update(chatThreads)
            .set({
              title: sql`coalesce(${chatThreads.title}, ${content.slice(0, TITLE_MAX_CHARS)})`,
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
              metadata: { threadId, assistantMessageId, userMessageId: body.userMessageId },
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
            const existingMessageId =
              existing &&
              typeof (existing.metadata as Record<string, unknown>)?.assistantMessageId === "string"
                ? ((existing.metadata as Record<string, unknown>).assistantMessageId as string)
                : assistantMessageId;
            return { runId: existing?.id ?? null, assistantMessageId: existingMessageId };
          }
        },
        {
          params: t.Object({ threadId: t.String({ minLength: 1, maxLength: 120 }) }),
          body: t.Object({
            userMessageId: t.String({ minLength: 1, maxLength: 100 }),
            content: t.String({ minLength: 1, maxLength: 100_000 }),
          }),
        },
      ),
  );
