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
 * Publish a chat thread to a public, read-only URL (ADR-0102).
 * A `shared_threads` row is public to anyone with the slug, so redact before the insert, never on read.
 */

const MAX_SNAPSHOT_MESSAGES = 500;

/** Measured on the redacted snapshot. The public route serves it with no session, so it must be bounded. */
const MAX_SNAPSHOT_BYTES = 2_000_000;

/** Never the snapshot bodies (ADR-0102 D12). */
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

/** Tool previews carry raw mail and `usage` carries spend, so both go. See `sharedThreadMessageSchema`. */
function toSharedMessage(row: ChatMessage, attachmentCount: number): SharedThreadMessage {
  return sharedThreadMessageSchema.parse({
    id: row.id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning,
    reasoningMs: row.reasoningMs,
    status: row.status,
    // Keep the tool trail's shape, drop its contents.
    toolCalls:
      row.toolCalls?.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: call.status,
        segmentIndex: call.segmentIndex ?? 0,
      })) ?? null,
    narration: row.narration ?? null,
    // A count, never a key or a URL: the files stay behind auth.
    attachmentCount,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * `null` drops the artifact. `external_file` would disclose the owner's Drive;
 * other kinds have no shared body yet. `pages` becomes a page count, so its HTML never reaches the row.
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

/** Same digest exactly when the page renders the same, so an edit or rename mints a new share. */
function snapshotDigest(snapshot: Snapshot): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

async function attachmentCountsByMessage(messageIds: string[]): Promise<Map<string, number>> {
  if (messageIds.length === 0) return new Map();

  const rows = await db()
    .select({ messageId: chatAttachments.messageId, total: count() })
    .from(chatAttachments)
    .where(inArray(chatAttachments.messageId, messageIds))
    .groupBy(chatAttachments.messageId);

  return new Map(rows.map((row) => [row.messageId, row.total]));
}

/** Throws when the thread cannot publish. The ownership check lives here, on the thread row. */
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

  // Only finished artifacts publish.
  const artifactRows = await db()
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.threadId, threadId), eq(artifacts.status, "complete")))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id));

  const attachmentCounts = await attachmentCountsByMessage(messageRows.map((row) => row.id));

  const snapshot: Snapshot = {
    // A missing title does not block the share.
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
 * Publish a thread, or return the share of the same page.
 * Each mint is one more public URL to revoke, so reuse matters.
 * The unique `(source_thread_id, snapshot_digest)` index is the guarantee; the read is an optimization.
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

  // A digest conflict has a winner to re-read; a slug conflict does not, so retry with a new slug.
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

/** Live shares of one thread, newest first. */
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

/** Delete the share and its snapshot. The `user_id` term is the auth check. `false` when already gone. */
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
 * The unauthenticated read: the slug is the capability.
 * Never join back to live chat or artifact tables; that would leak later edits.
 * Parse because jsonb `.$type<>()` checks nothing at runtime.
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
