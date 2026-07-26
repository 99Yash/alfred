import { parseEmailAddress, toStringArray } from "@alfred/contracts";
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
  const labelIds = toStringArray(meta.labelIds);
  return meta.isSent === true || labelIds.some((label) => label === SENT_LABEL);
}

/**
 * Whether a document whose *stored* metadata says "not sent" could nonetheless
 * be the user's own sent mail — i.e. whether the live Gmail label check is
 * worth a network round trip.
 *
 * The gap it guards (#306): `metadata.isSent` is frozen at ingest from
 * `labelIds.includes("SENT")`, and ingest is `onConflictDoNothing`, so a message
 * first seen inside the send/draft transition window is stored — permanently —
 * as received. But every message that gap can mis-flag is one **the user sent**,
 * so its envelope `From` is one of the user's own addresses. When `From` is a
 * third party, no live label can turn the document into the user's sent mail,
 * and the round trip is pure hot-path latency (#439) — for received mail, the
 * common case, it sat in front of *every* classify.
 *
 * So: ambiguous (→ check live) when `From` is missing or unparseable, when the
 * account address can't be resolved, or when `From` is the account address.
 *
 * Pass the raw envelope `From`, deliberately NOT a `SenderContext`'s
 * `effectiveAuthor`: Gmail's `SENT` label tracks who actually sent the message,
 * not the forwarded-mail author a body parse recovers.
 *
 * Residual gap, accepted rather than papered over: a user sending through a
 * Gmail **send-as alias** has `From` ≠ the account address, so this skips the
 * live check for them. Hitting it also requires ingestion inside the transition
 * window *and* the upstream stored-`SENT` fan-out exclusion missing the message.
 * Narrow enough to accept today — but if alias sending ever becomes a supported
 * feature, this predicate is what has to learn about it.
 */
export function mayBeUnflaggedSentMail(args: {
  /** Raw envelope `From` header, e.g. `Yash <yash@example.com>`. */
  fromHeader: string | null;
  /** The mailbox's own address (per-account credential label). */
  accountEmail: string | null;
}): boolean {
  const from = parseEmailAddress(args.fromHeader);
  if (!from) return true;
  const accountEmail = parseEmailAddress(args.accountEmail);
  if (!accountEmail) return true;
  return from === accountEmail;
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
