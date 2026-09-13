import {
  buildSharedThreadSlug,
  canonicalJson,
  Errors,
  SHARED_THREAD_SLUG_SUFFIX_LENGTH,
  sharedThreadArtifactSchema,
  sharedThreadMessageSchema,
  sharedThreadPageSchema,
  type SharedThreadArtifact,
  type SharedThreadMessage,
  type SharedThreadPage,
  type SharedThreadSummary,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import {
  artifacts,
  chatAttachments,
  chatMessages,
  chatThreads,
  sharedThreads,
} from "@alfred/db/schemas";
import type { Artifact, ChatMessage, SharedThread } from "@alfred/db/schemas";
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

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
 * `toSharedMessage` and `toSharedArtifact` runs BEFORE the insert, never on the
 * way out.
 */

/** A thread with more turns than this refuses to publish rather than mint a huge row. */
const MAX_SNAPSHOT_MESSAGES = 500;

/**
 * Hard ceiling on the canonical bytes of one snapshot.
 *
 * The message cap alone does not bound the row: 500 turns of long replies and
 * long reasoning is unbounded in bytes, and the public route serves the whole
 * value to an unauthenticated caller with no session to slow it down. This is
 * the ceiling that makes one known slug cost a predictable amount to fetch.
 *
 * It is measured on the REDACTED snapshot, after `pages` bodies have collapsed
 * to a count, so it bounds exactly what ships.
 */
const MAX_SNAPSHOT_BYTES = 2_000_000;

/** The columns the owner's share list needs. Never the snapshot bodies (ADR-0102 D12). */
const summaryColumns = {
  id: sharedThreads.id,
  urlSlug: sharedThreads.urlSlug,
  title: sharedThreads.title,
  messageCount: sharedThreads.messageCount,
  artifactCount: sharedThreads.artifactCount,
  createdAt: sharedThreads.createdAt,
} as const;

type SummaryRow = Pick<
  SharedThread,
  "id" | "urlSlug" | "title" | "messageCount" | "artifactCount" | "createdAt"
>;

/**
 * Strip a durable chat message down to its publication shape.
 *
 * Everything dropped here is dropped for a reason recorded on
 * `sharedThreadMessageSchema`; the short version is that tool previews carry
 * raw mail and calendar content, and `usage` carries the owner's spend.
 */
function toSharedMessage(row: ChatMessage, attachmentCount: number): SharedThreadMessage {
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
    // A count, never a key or a URL. The bytes stay behind the owner's
    // auth-gated content proxy; the count is what stops a turn that carried
    // three files from reading as a bare sentence.
    attachmentCount,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Strip an artifact row down to its publication shape, or refuse it.
 *
 * A `null` return DROPS the artifact from the snapshot, and both null cases are
 * deliberate rather than defensive:
 *
 *   - `external_file` — the body is a pointer into the owner's Drive (file id,
 *     preview URL, file name). A visitor cannot open any of it, and publishing
 *     the pointer discloses the owner's filing.
 *   - a kind with no body variant yet (`spreadsheet`) — nothing to draw.
 *
 * A `pages` body collapses to its page count HERE, at write time, so the HTML
 * never reaches the row. That is the whole reason the public page can decline
 * to render foreign HTML without also paying to store it.
 */
function toSharedArtifact(row: Artifact): SharedThreadArtifact | null {
  const content = row.content;

  if (!content) return null;

  const body =
    content.kind === "document"
      ? { kind: "document" as const, markdown: content.markdown }
      : content.kind === "pages"
        ? { kind: "pages" as const, pageCount: content.pages.length }
        : null;

  if (!body) return null;

  return sharedThreadArtifactSchema.parse({
    id: row.id,
    title: row.title,
    body,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Shape the owner's share list and the post-publish dialog both read. */
function toSummary(row: SummaryRow): SharedThreadSummary {
  return {
    id: row.id,
    urlSlug: row.urlSlug,
    title: row.title,
    messageCount: row.messageCount,
    artifactCount: row.artifactCount,
    sharedAt: row.createdAt.toISOString(),
  } satisfies SharedThreadSummary;
}

interface Snapshot {
  title: string;
  messages: SharedThreadMessage[];
  artifacts: SharedThreadArtifact[];
}

/**
 * The identity of a published page, as one value.
 *
 * Every field a visitor can see feeds the hash, so two snapshots share a digest
 * exactly when they would render the same page. The three proxies this replaces
 * — message count, artifact count, last message id — all miss an EDIT: a
 * rename, an `update_artifact` rewrite, and a retried turn each leave all three
 * unchanged while changing the page.
 *
 * `canonicalJson` sorts object keys, so the digest does not depend on the order
 * a mapper happened to build its fields in.
 */
function snapshotDigest(snapshot: Snapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/** How many attachments rode with each message, keyed by message id. */
async function attachmentCountsByMessage(messageIds: string[]): Promise<Map<string, number>> {
  if (messageIds.length === 0) return new Map();

  const rows = await db()
    .select({ messageId: chatAttachments.messageId, total: count() })
    .from(chatAttachments)
    .where(inArray(chatAttachments.messageId, messageIds))
    .groupBy(chatAttachments.messageId);

  return new Map(rows.map((row) => [row.messageId, row.total]));
}

/**
 * Read the thread and build the snapshot, or throw the reason it cannot be
 * published. Ownership is checked HERE, on the thread, because that is the row
 * that carries `user_id` — a caller that only checked the id would happily
 * publish someone else's thread.
 */
async function buildSnapshot(userId: string, threadId: string): Promise<Snapshot> {
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

  const attachmentCounts = await attachmentCountsByMessage(messageRows.map((row) => row.id));

  const snapshot: Snapshot = {
    // A thread whose title has not been derived yet still publishes; it just
    // reads as "Untitled chat" rather than blocking the share the way
    // Dimension's "Thread name is required before sharing" does.
    title: thread.title?.trim() || "Untitled chat",
    messages: messageRows.map((row) => toSharedMessage(row, attachmentCounts.get(row.id) ?? 0)),
    artifacts: artifactRows.flatMap((row) => toSharedArtifact(row) ?? []),
  };

  const bytes = Buffer.byteLength(canonicalJson(snapshot), "utf8");

  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw Errors.BadRequestError(
      `This thread is too large to share (${Math.round(bytes / 1000)} KB; the limit is ${MAX_SNAPSHOT_BYTES / 1000} KB).`,
    );
  }

  return snapshot;
}

/**
 * Publish a thread, or hand back the share that already covers it.
 *
 * REUSE MATTERS FOR MORE THAN TIDINESS. Every mint is a second live public URL
 * that the owner must remember to revoke separately, so a Share button that
 * minted per click would quietly scatter copies of a private conversation.
 *
 * Reuse is decided by ONE indexed equality: `(source_thread_id,
 * snapshot_digest)` is unique, so a re-publish of an identical page cannot
 * insert a second row even when two requests race. The read below is an
 * optimization and the index is the guarantee — a double click loses the insert
 * and re-reads the winner rather than minting a rival URL.
 *
 * Once the thread moves on — a new turn, a rename, an edited artifact — the
 * digest changes, a new share is minted, and the old URL keeps serving its own
 * older snapshot, which is the point of snapshots.
 */
export async function shareThread({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<SharedThreadSummary> {
  const snapshot = await buildSnapshot(userId, threadId);
  const digest = snapshotDigest(snapshot);

  const findExisting = async (): Promise<SummaryRow | undefined> => {
    const [row] = await db()
      .select(summaryColumns)
      .from(sharedThreads)
      .where(
        and(eq(sharedThreads.sourceThreadId, threadId), eq(sharedThreads.snapshotDigest, digest)),
      )
      .limit(1);

    return row;
  };

  const existing = await findExisting();

  if (existing) return toSummary(existing);

  // Two unique indexes can reject this insert: the digest (a concurrent click
  // published the same page first) and the slug (80 bits of suffix, so chance
  // is not the explanation). `onConflictDoNothing` with no target covers both,
  // and the re-read tells them apart — a digest conflict has a winner to
  // return, a slug conflict does not, so the loop tries a fresh slug.
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
        snapshotDigest: digest,
        messageCount: snapshot.messages.length,
        artifactCount: snapshot.artifacts.length,
      })
      .onConflictDoNothing()
      .returning(summaryColumns);

    if (row) return toSummary(row);

    const winner = await findExisting();

    if (winner) return toSummary(winner);
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
    .select(summaryColumns)
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
 *
 * The `.parse` is not ceremony. `.$type<>()` on a jsonb column informs
 * TypeScript and checks nothing at runtime, and this is the one response body
 * in the API that ships without a session — the worst place in the tree to
 * assert a shape. A repair script, a backfill, or a row written before a field
 * existed all reach this line, so every field the publication shapes added
 * since carries a default and an old row still parses. A row that genuinely
 * cannot parse raises here, where the server sees it, rather than failing
 * silently in the visitor's browser as "not available".
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

  return sharedThreadPageSchema.parse({
    urlSlug: row.urlSlug,
    title: row.title,
    messages: row.messages,
    artifacts: row.artifacts,
    sharedAt: row.createdAt.toISOString(),
  });
}
