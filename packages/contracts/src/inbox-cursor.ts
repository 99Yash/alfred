/**
 * Inbox cursor codec — browser-safe.
 *
 * `GET /api/me/inbox` is the single unbounded list in the repo that needs
 * keyset pagination. It orders by `authoredAt DESC, id DESC` and uses a
 * composite cursor `<authoredAtISO>|<documentId>` to tie-break rows that
 * share a millisecond (Gmail batch ingestion). Before #317 this codec was
 * local to `packages/http/src/me.ts`; extracting it here makes the wire
 * shape explicit without inventing a generic pagination primitive.
 *
 * This file is inbox-specific on purpose — the name says `inbox`, not
 * `cursor-pagination`. A future list that needs paging should add its own
 * codec that matches its own ORDER BY, not reuse this separator.
 *
 * The Drizzle `WHERE` that mirrors this cursor's ORDER BY lives inline
 * in `packages/http/src/me.ts` (next to its `ORDER BY`) because it
 * imports `drizzle-orm` and `@alfred/db/schemas` and is not browser-safe.
 * It is inbox-specific and used once — no separate `pagination.ts`.
 */

export const INBOX_CURSOR_SEPARATOR = "|";

/** Parsed inbox cursor — the two components that make the tie-break stable. */
export interface ParsedInboxCursor {
  authoredAt: Date;
  documentId: string;
}

/**
 * Encode an inbox cursor. The shape is `<authoredAtISO>|<documentId>`.
 * `authoredAt` is serialized with `toISOString()` so the codec round-trips
 * through `new Date(iso)` without loss.
 *
 * `documentId` is a `createId("doc")` value which never contains `|`, so
 * `indexOf("|")` on decode is unambiguous. Do not reuse this codec for an
 * id alphabet that may contain `|`.
 */
export function encodeInboxCursor(parsed: ParsedInboxCursor): string {
  return `${parsed.authoredAt.toISOString()}${INBOX_CURSOR_SEPARATOR}${parsed.documentId}`;
}

/**
 * Decode an inbox cursor.
 *
 * Returns `null` for no cursor, `"invalid"` for a parse failure, or the
 * decoded pair for a valid cursor. A missing `|` (legacy timestamp-only
 * cursor) is `invalid` rather than silently advancing — clients pick up the
 * new shape on the next page, never mid-pagination.
 */
export function parseInboxCursor(raw: string | undefined): ParsedInboxCursor | null | "invalid" {
  if (!raw) return null;
  const sep = raw.indexOf(INBOX_CURSOR_SEPARATOR);
  if (sep < 0) return "invalid";
  const iso = raw.slice(0, sep);
  const documentId = raw.slice(sep + 1);
  if (!iso || !documentId) return "invalid";
  const authoredAt = new Date(iso);
  if (Number.isNaN(authoredAt.getTime())) return "invalid";
  return { authoredAt, documentId };
}
