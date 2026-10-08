/**
 * Keyset cursor for `GET /api/me/inbox`, ordered by `authoredAt DESC, id DESC`.
 * The id breaks ties between rows in the same millisecond. Inbox only: another list
 * needs its own codec that matches its ORDER BY. The matching `WHERE` is in `packages/http/src/me.ts`.
 */

export const INBOX_CURSOR_SEPARATOR = "|";

export interface ParsedInboxCursor {
  authoredAt: Date;
  documentId: string;
}

/** `<authoredAtISO>|<documentId>`. Safe because a `createId("doc")` id never contains `|`. */
export function encodeInboxCursor(parsed: ParsedInboxCursor): string {
  return `${parsed.authoredAt.toISOString()}${INBOX_CURSOR_SEPARATOR}${parsed.documentId}`;
}

/** `null` for no cursor, `"invalid"` for a bad one, including a missing `|`. */
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
