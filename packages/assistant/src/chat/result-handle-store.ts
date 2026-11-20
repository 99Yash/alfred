/**
 * The handle store (ADR-0087 point 2, ADR-0130 decision 5): the JSON in object storage under the
 * thread's prefix, and a `result_handles` row for its metadata. A handle lives 3 days from its
 * fetch (owner, 2026-11-20). `sweepExpiredResultHandles` deletes expired rows and their objects; a
 * thread delete cascades the rows, and the thread's prefix cleanup removes the objects.
 */
import { toJsonValue, type JsonValue } from "@alfred/contracts";
import { db } from "@alfred/db";
import { createId } from "@alfred/db/helpers";
import { resultHandles } from "@alfred/db/schemas";
import { logger } from "@alfred/logging";
import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import type { ResultHandleStore, StoredResultRef } from "@alfred/assistant/tool-runtime";
import { deleteObjects, isStorageConfigured, readObject, writeObject } from "./attachments/storage";

/** How long a handle stays readable after its fetch (owner, 2026-11-20). */
export const RESULT_HANDLE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Rows that one sweep round deletes. */
const SWEEP_BATCH = 500;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** Under the thread's prefix (`buildAttachmentKey`), so a thread delete reaps it. */
function resultHandleKey(userId: string, threadId: string, handle: string): string {
  return `chat/${userId}/${threadId}/handles/${handle}.json`;
}

async function storedRefOf(runId: string, toolCallId: string): Promise<StoredResultRef | null> {
  const [row] = await db()
    .select({ handle: resultHandles.id, fetchedAt: resultHandles.fetchedAt })
    .from(resultHandles)
    .where(and(eq(resultHandles.runId, runId), eq(resultHandles.toolCallId, toolCallId)))
    .limit(1);

  return row ?? null;
}

const park: ResultHandleStore["park"] = async (args) => {
  if (!isStorageConfigured()) return null;

  // A replay of the call gives the handle that the first attempt stored.
  const existing = await storedRefOf(args.runId, args.toolCallId);

  if (existing) return existing;

  const handle = createId("rh");
  const storageKey = resultHandleKey(args.userId, args.threadId, handle);
  const bytes = encoder.encode(JSON.stringify(args.value));
  const fetchedAt = new Date();

  await writeObject(storageKey, bytes, "application/json");

  const [inserted] = await db()
    .insert(resultHandles)
    .values({
      id: handle,
      userId: args.userId,
      threadId: args.threadId,
      messageId: args.messageId,
      runId: args.runId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      query: args.query,
      itemCount: args.itemCount,
      byteSize: bytes.length,
      storageKey,
      fetchedAt,
      expiresAt: new Date(fetchedAt.getTime() + RESULT_HANDLE_TTL_MS),
    })
    .onConflictDoNothing({ target: [resultHandles.runId, resultHandles.toolCallId] })
    .returning({ handle: resultHandles.id, fetchedAt: resultHandles.fetchedAt });

  if (inserted) return inserted;

  // A parallel attempt of the same call won. Its row is the handle; this object is an orphan.
  await deleteObjects([storageKey]);

  return storedRefOf(args.runId, args.toolCallId);
};

const load: ResultHandleStore["load"] = async (args) => {
  const [row] = await db()
    .select()
    .from(resultHandles)
    .where(
      and(
        eq(resultHandles.id, args.handle),
        eq(resultHandles.userId, args.userId),
        eq(resultHandles.threadId, args.threadId),
        gt(resultHandles.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) return null;

  const bytes = await readObject(row.storageKey);
  const value: JsonValue = toJsonValue(JSON.parse(decoder.decode(bytes)));

  return {
    handle: row.id,
    fetchedAt: row.fetchedAt,
    toolName: row.toolName,
    query: row.query,
    value,
  };
};

export const chatResultHandleStore: ResultHandleStore = { park, load };

/** One transcript line of an earlier result (ADR-0130 decision 5). */
interface ResultHandleLine {
  messageId: string;
  handle: string;
  toolName: string;
  query: string;
  itemCount: number | null;
  fetchedAt: Date;
}

/** The live handles of these assistant messages, in fetch order. */
async function liveResultHandles(args: {
  userId: string;
  threadId: string;
  messageIds: readonly string[];
}): Promise<ResultHandleLine[]> {
  if (args.messageIds.length === 0) return [];

  return db()
    .select({
      messageId: resultHandles.messageId,
      handle: resultHandles.id,
      toolName: resultHandles.toolName,
      query: resultHandles.query,
      itemCount: resultHandles.itemCount,
      fetchedAt: resultHandles.fetchedAt,
    })
    .from(resultHandles)
    .where(
      and(
        eq(resultHandles.userId, args.userId),
        eq(resultHandles.threadId, args.threadId),
        inArray(resultHandles.messageId, [...args.messageIds]),
        gt(resultHandles.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(resultHandles.fetchedAt), asc(resultHandles.id));
}

/** One line: the handle, the tool and its input, the item count, and the fetch time. */
function handleLine(line: ResultHandleLine): string {
  const items =
    line.itemCount === null ? "" : `, ${line.itemCount} ${line.itemCount === 1 ? "item" : "items"}`;

  return `- ${line.handle}: ${line.toolName} ${line.query}${items}, fetched ${line.fetchedAt.toISOString()}`;
}

/**
 * The note after each assistant message whose turn stored results: one line for each live handle.
 * The model reads the data again with `system.load_result` in a script, or it fetches new data when
 * the fetch time is too old for the question (ADR-0130 decisions 5 and 7).
 */
export async function resultHandleLinesByMessage(args: {
  userId: string;
  threadId: string;
  messageIds: readonly string[];
}): Promise<Map<string, string>> {
  const byMessage = new Map<string, ResultHandleLine[]>();

  for (const line of await liveResultHandles(args)) {
    byMessage.set(line.messageId, [...(byMessage.get(line.messageId) ?? []), line]);
  }

  return new Map(
    [...byMessage].map(([messageId, lines]) => [
      messageId,
      [
        "[Stored results of this turn. To read one again, call system.load_result({ handle }) in a script.]",
        ...lines.map(handleLine),
      ].join("\n"),
    ]),
  );
}

/** Delete expired handles and their objects. Returns the count of rows removed. */
export async function sweepExpiredResultHandles(now: Date = new Date()): Promise<number> {
  let removed = 0;

  for (;;) {
    const rows = await db()
      .select({ id: resultHandles.id, storageKey: resultHandles.storageKey })
      .from(resultHandles)
      .where(lte(resultHandles.expiresAt, now))
      .limit(SWEEP_BATCH);

    if (rows.length === 0) return removed;

    // The objects go first: a row without its object reads as gone, but an object without its row
    // would never be found again.
    if (isStorageConfigured()) await deleteObjects(rows.map((row) => row.storageKey));

    await db()
      .delete(resultHandles)
      .where(
        inArray(
          resultHandles.id,
          rows.map((row) => row.id),
        ),
      );

    removed += rows.length;
    logger.info(`[result-handles] swept ${rows.length} expired handle(s)`);

    if (rows.length < SWEEP_BATCH) return removed;
  }
}
