import {
  buildSharedThreadSlug,
  Errors,
  SHARED_THREAD_SLUG_SUFFIX_LENGTH,
  sharedThreadArtifactSchema,
  sharedThreadMessageSchema,
  type SharedThreadArtifact,
  type SharedThreadMessage,
  type SharedThreadPage,
  type SharedThreadSummary,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { artifacts, chatMessages, chatThreads, sharedThreads } from "@alfred/db/schemas";
import type { Artifact, ChatMessage, SharedThread } from "@alfred/db/schemas";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";

/**
 * Publishing a chat thread to a public, read-only URL (ADR-0102).
 *
 * This module owns every decision a share takes: what a snapshot may contain,
 * when a click mints a new URL instead of reusing one, and what an
 * unauthenticated visitor is allowed to read back. `packages/http/src/sharing.ts`
 * holds transport only.
 *
 * The one rule to keep in mind when editing anything here: a `shared_threads`
 * row is world-readable to whoever holds its slug, so the redaction in
 * `toSharedMessage` runs BEFORE the insert, never on the way out.
 */

/** A thread with more turns than this refuses to publish rather than mint a huge row. */
const MAX_SNAPSHOT_MESSAGES = 500;

/**
 * Strip a durable chat message down to its publication shape.
 *
 * Everything dropped here is dropped for a reason recorded on
 * `sharedThreadMessageSchema`; the short version is that tool previews carry
 * raw mail and calendar content, and `usage` carries the owner's spend.
 */
function toSharedMessage(row: ChatMessage): SharedThreadMessage {
  return sharedThreadMessageSchema.parse({
    id: row.id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    reasoningMs: row.reasoningMs,
    status: row.status,
    // The tool trail keeps its shape and loses its contents: a visitor sees
    // that Alfred searched email, never which mail it read.
    toolCalls:
      row.toolCalls?.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: call.status,
        segmentIndex: call.segmentIndex ?? 0,
      })) ?? null,
    narration: row.narration ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Strip an artifact row down to its publication shape. Only `complete` rows reach this. */
function toSharedArtifact(row: Artifact): SharedThreadArtifact {
  return sharedThreadArtifactSchema.parse({
    id: row.id,
    kind: row.kind,
    format: row.format,
    title: row.title,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Shape the owner's share list and the post-publish dialog both read. */
function toSummary(row: Pick<SharedThread, "id" | "urlSlug" | "title" | "messages" | "createdAt">) {
  return {
    id: row.id,
    urlSlug: row.urlSlug,
    title: row.title,
    messageCount: row.messages.length,
    sharedAt: row.createdAt.toISOString(),
  } satisfies SharedThreadSummary;
}

/**
 * Read the thread and build the snapshot, or throw the reason it cannot be
 * published. Ownership is checked HERE, on the thread, because that is the row
 * that carries `user_id` — a caller that only checked the id would happily
 * publish someone else's thread.
 */
async function buildSnapshot(userId: string, threadId: string) {
  const [thread] = await db()
    .select({ id: chatThreads.id, title: chatThreads.title })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!thread) throw Errors.NotFoundError("Thread not found");

  const messageRows = await db()
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

  if (messageRows.length === 0) {
    throw Errors.BadRequestError("This thread has no messages to share yet.");
  }

  if (messageRows.length > MAX_SNAPSHOT_MESSAGES) {
    throw Errors.BadRequestError(
      `This thread has ${messageRows.length} messages; sharing is capped at ${MAX_SNAPSHOT_MESSAGES}.`,
    );
  }

  // Only finished artifacts publish. A `generating` body is half-written and an
  // `error` body is a failure the owner never chose to show.
  const artifactRows = await db()
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.threadId, threadId), eq(artifacts.status, "complete")))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id));

  return {
    // A thread whose title has not been derived yet still publishes; it just
    // reads as "Untitled chat" rather than blocking the share the way
    // Dimension's "Thread name is required before sharing" does.
    title: thread.title?.trim() || "Untitled chat",
    messages: messageRows.map(toSharedMessage),
    artifacts: artifactRows.map(toSharedArtifact),
  };
}

/**
 * Publish a thread, or hand back the share that already covers it.
 *
 * REUSE MATTERS FOR MORE THAN TIDINESS. Every mint is a second live public URL
 * that the owner must remember to revoke separately, so a Share button that
 * minted per click would quietly scatter copies of a private conversation. A
 * share is reused when the newest one for this thread ends on the same message
 * and holds the same number of messages and artifacts — i.e. when re-publishing
 * would produce the same page. Once the thread moves on, a new share is minted
 * and the old URL keeps serving its own older snapshot, which is the point of
 * snapshots.
 */
export async function shareThread({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<SharedThreadSummary> {
  const snapshot = await buildSnapshot(userId, threadId);

  const [existing] = await db()
    .select()
    .from(sharedThreads)
    .where(and(eq(sharedThreads.sourceThreadId, threadId), eq(sharedThreads.userId, userId)))
    .orderBy(desc(sharedThreads.createdAt))
    .limit(1);

  const lastId = (rows: readonly SharedThreadMessage[]) => rows.at(-1)?.id;

  if (
    existing &&
    existing.messages.length === snapshot.messages.length &&
    existing.artifacts.length === snapshot.artifacts.length &&
    lastId(existing.messages) === lastId(snapshot.messages)
  ) {
    return toSummary(existing);
  }

  // The unique index on `url_slug` is the real arbiter. 80 bits of suffix makes
  // a collision effectively impossible, so a handful of retries is generous;
  // exhausting them means something other than chance is wrong, and it should
  // surface rather than loop.
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await db()
      .insert(sharedThreads)
      .values({
        userId,
        sourceThreadId: threadId,
        urlSlug: buildSharedThreadSlug(
          snapshot.title,
          randomBytes(SHARED_THREAD_SLUG_SUFFIX_LENGTH),
        ),
        title: snapshot.title,
        messages: snapshot.messages,
        artifacts: snapshot.artifacts,
      })
      .onConflictDoNothing({ target: sharedThreads.urlSlug })
      .returning();

    if (row) return toSummary(row);
  }

  throw Errors.ConflictError("Could not allocate a share link; please try again.");
}

/** Every live share of one thread, newest first, for the dialog's revoke list. */
export async function listThreadShares({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<SharedThreadSummary[]> {
  const rows = await db()
    .select()
    .from(sharedThreads)
    .where(and(eq(sharedThreads.sourceThreadId, threadId), eq(sharedThreads.userId, userId)))
    .orderBy(desc(sharedThreads.createdAt));

  return rows.map(toSummary);
}

/**
 * Revoke a share by deleting it. The snapshot bytes go with the row, so a
 * revoked share leaves nothing behind to leak later.
 *
 * The `user_id` term in the WHERE clause is the authorization check, not a
 * filter: without it the id alone would let any signed-in caller delete any
 * share. Returns false when nothing matched, so a double-click reads as "already
 * gone" rather than an error.
 */
export async function revokeSharedThread({
  userId,
  sharedThreadId,
}: {
  userId: string;
  sharedThreadId: string;
}): Promise<boolean> {
  const deleted = await db()
    .delete(sharedThreads)
    .where(and(eq(sharedThreads.id, sharedThreadId), eq(sharedThreads.userId, userId)))
    .returning({ id: sharedThreads.id });

  return deleted.length > 0;
}

/**
 * Read a published thread by slug. THIS IS THE UNAUTHENTICATED PATH.
 *
 * It takes a slug and nothing else — no user, no session — because the slug is
 * the capability. Note what it does not do: it never joins back to
 * `chat_threads`, `chat_messages`, or `artifacts`. The snapshot columns are the
 * whole answer. Dimension's equivalent re-reads artifact bodies live by id,
 * which both leaks post-publish edits onto an already-shared page and widens
 * the query past what the owner published; keep this read closed over the row.
 */
export async function readSharedThreadPage(urlSlug: string): Promise<SharedThreadPage | null> {
  const [row] = await db()
    .select({
      urlSlug: sharedThreads.urlSlug,
      title: sharedThreads.title,
      messages: sharedThreads.messages,
      artifacts: sharedThreads.artifacts,
      createdAt: sharedThreads.createdAt,
    })
    .from(sharedThreads)
    .where(eq(sharedThreads.urlSlug, urlSlug))
    .limit(1);

  if (!row) return null;

  return {
    urlSlug: row.urlSlug,
    title: row.title,
    messages: row.messages,
    artifacts: row.artifacts,
    sharedAt: row.createdAt.toISOString(),
  };
}
