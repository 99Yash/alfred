import { documents } from "@alfred/db/schemas";
import { sql, type SQL } from "drizzle-orm";

/**
 * Canonical "is this Gmail document one the USER sent?" predicate — in both JS
 * and SQL form — so every consumer agrees on the rule. Previously three copies
 * had drifted: the inbox query (me/routes) checked both signals, while the
 * triage thread-state scan and the sender-prior write-back guard checked only
 * `metadata.isSent` and silently mis-read SENT-labelled docs.
 *
 * A doc counts as sent when EITHER `metadata.isSent === true` (set by the
 * ingestor going forward) OR `metadata.labelIds` contains "SENT" (the raw Gmail
 * label — also covers any doc carrying the label without the flag). Keep the JS
 * and SQL forms in lockstep: both must check both signals.
 */

const SENT_LABEL = "SENT";

/** JS predicate over a document's `metadata` object. */
export function isSentGmailMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  const meta = metadata ?? {};
  const labelIds = Array.isArray(meta.labelIds) ? (meta.labelIds as unknown[]) : [];
  return meta.isSent === true || labelIds.some((label) => label === SENT_LABEL);
}

/**
 * SQL boolean: true when `documents.metadata` marks the row as sent. The jsonb
 * `?` operator keeps `'SENT'` as a literal (matching the JS {@link SENT_LABEL}).
 */
export function gmailSentSql(): SQL<boolean> {
  return sql<boolean>`(COALESCE((${documents.metadata} ->> 'isSent')::boolean, false)
    OR COALESCE(${documents.metadata} -> 'labelIds', '[]'::jsonb) ? 'SENT')`;
}

/** SQL boolean: the negation — a row that is NOT sent (the inbox filter). */
export function notSentGmailDocumentWhere(): SQL<boolean> {
  return sql<boolean>`NOT ${gmailSentSql()}`;
}
