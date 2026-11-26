import { parseIanaTimezone, parseMailbox } from "@alfred/contracts";
import { readMailFacts, type MailFacts } from "@alfred/assistant/knowledge/mail-facts";

/** The eval mailbox. Every eval mail arrives at this account. */
const EVAL_ACCOUNT_ID = "acct_eval";

const EVAL_MAILBOX = "yash@example.com";

const EVAL_TIMEZONE = parseIanaTimezone("Asia/Kolkata");

/** An eval mail, as the stored Gmail message is built from it. */
export interface EvalStoredMail {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly authoredAt: Date;
  readonly labelIds: readonly string[];
  /** Stored headers beyond From, Subject, and Date. No `To` here means no To header. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Lower-bound correspondent counts for the sender, from the fixture's prior-mail evidence. */
  readonly history?: EvalCorrespondentCounts | undefined;
  /**
   * The user's own sent messages in the thread, newest first (`MailFacts.ownReplies`), as the
   * reader's ctx takes them. The prompt does not render them yet (slice 3 decides).
   */
  readonly ownReplies?: readonly { at: Date; text: string }[] | undefined;
}

/** Lower-bound counts from the fixture's prior-mail evidence. */
export interface EvalCorrespondentCounts {
  readonly receivedCount: number;
  readonly sentCount: number;
}

/** A stored Gmail message (`documents.raw`) for an eval mail: one `text/plain` part. */
export function evalStoredGmailMessage(mail: EvalStoredMail) {
  const headers = {
    From: mail.from,
    Subject: mail.subject,
    Date: mail.authoredAt.toUTCString(),
    ...mail.headers,
  };

  return {
    id: mail.id,
    threadId: mail.id,
    labelIds: [...mail.labelIds],
    internalDate: String(mail.authoredAt.getTime()),
    payload: {
      mimeType: "text/plain",
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      body: { data: Buffer.from(mail.body, "utf8").toString("base64url") },
    },
  };
}

/**
 * The mail facts of an eval mail, read by the prod reader from a stored Gmail message. The
 * evals take every mail fact from here, the sender context too, so they see what prod sees.
 */
export function evalMailFacts(mail: EvalStoredMail): MailFacts {
  const senderAddress = parseMailbox(mail.from)?.address;

  // The fixture knows the counts, but rarely has the timestamps of the earlier mail.
  const history = mail.history;
  const storedSince = new Date("2026-09-05T00:00:00Z");

  const correspondentHistory =
    senderAddress && history
      ? new Map([
          [
            senderAddress,
            {
              address: senderAddress,
              displayName: null,
              firstSeenAt: null,
              lastSeenAt: null,
              windowStartedAt: storedSince <= mail.authoredAt ? storedSince : null,
              receivedCount: history.receivedCount,
              lastReceivedAt: null,
              sentCount: history.sentCount,
              lastSentAt: null,
            },
          ],
        ])
      : new Map();

  return readMailFacts(
    {
      id: mail.id,
      sourceId: mail.id,
      sourceThreadId: mail.id,
      accountId: EVAL_ACCOUNT_ID,
      title: mail.subject,
      content: mail.body,
      authoredAt: mail.authoredAt,
      raw: evalStoredGmailMessage(mail),
      metadata: { from: mail.from, labelIds: [...mail.labelIds] },
    },
    {
      timezone: EVAL_TIMEZONE,
      mailboxByAccountId: new Map([[EVAL_ACCOUNT_ID, EVAL_MAILBOX]]),
      userAddresses: new Set([EVAL_MAILBOX]),
      correspondentHistory,
      ownReplies: mail.ownReplies ?? [],
    },
  );
}
