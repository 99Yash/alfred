import { parseEmailAddress } from "@alfred/contracts";
import { documents } from "@alfred/db/schemas";
import { sql, type SQL } from "drizzle-orm";

/**
 * "Did the user send this?" in JS and SQL. Sent means `metadata.isSent` OR a
 * `SENT` label. Keep both forms checking both signals.
 */

export { isSentGmailMetadata } from "@alfred/contracts";

/**
 * Could a stored "not sent" doc still be the user's sent mail? If not, skip the
 * live Gmail check (#439). `isSent` is frozen at ingest, so a message caught
 * mid-send stays "received" (#306); but such a message has the user's own `From`.
 * Pass the authoritative mailbox address, never `identity.email`: its fallback
 * breaks a second mailbox. Accepted gap: a send-as alias skips the check.
 */
export function mayBeUnflaggedSentMail(args: {
  /** Raw envelope `From`, not `effectiveAuthor`. */
  fromHeader: string | null;
  /** From the credential label only. Null runs the live check. */
  mailboxAddress: string | null;
}): boolean {
  const from = parseEmailAddress(args.fromHeader);

  if (!from) return true;
  const mailboxAddress = parseEmailAddress(args.mailboxAddress);

  if (!mailboxAddress) return true;

  return from === mailboxAddress;
}

/** SQL form of {@link isSentGmailMetadata}. */
export function gmailSentSql(): SQL<boolean> {
  return sql<boolean>`(COALESCE((${documents.metadata} ->> 'isSent')::boolean, false)
    OR COALESCE(${documents.metadata} -> 'labelIds', '[]'::jsonb) ? 'SENT')`;
}

/** The inbox filter. */
export function notSentGmailDocumentWhere(): SQL<boolean> {
  return sql<boolean>`NOT ${gmailSentSql()}`;
}
