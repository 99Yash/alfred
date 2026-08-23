import { and, eq, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { documents } from "@alfred/db/schemas";
import type { ParsedInboxCursor } from "@alfred/contracts";

/**
 * Drizzle `WHERE` fragment for the inbox cursor.
 *
 * The inbox orders by `authoredAt DESC, id DESC` and pages with a composite
 * cursor `<authoredAtISO>|<documentId>`. The filter must mirror that order:
 * rows strictly before the cursor in `(authoredAt, id)` lexicographic order,
 * with `id` tie-breaking rows that share an `authoredAt` (Gmail batch
 * notifications routinely share an `internalDate` to the millisecond — a plain
 * timestamp cursor with `lt` would leak the tied row off the next page).
 *
 * Returns `undefined` when there is no cursor so the caller can `and(base, cursor)`
 * without branching. This function is inbox-specific — a future list must add
 * its own `WHERE` that mirrors its own `ORDER BY`, not reuse this one.
 */
export function inboxCursorWhere(cursor: ParsedInboxCursor | null): SQL<unknown> | undefined {
  if (!cursor) return undefined;
  return or(
    lt(documents.authoredAt, cursor.authoredAt),
    and(eq(documents.authoredAt, cursor.authoredAt), lt(documents.id, cursor.documentId)),
  );
}
