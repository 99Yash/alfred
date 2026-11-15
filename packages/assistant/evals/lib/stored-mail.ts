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
  /** The sender is a known contact. */
  readonly knownContact?: boolean | undefined;
}

/** A stored Gmail message (`documents.raw`) for an eval mail: one `text/plain` part. */
function storedGmailMessage(mail: EvalStoredMail) {
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

  return readMailFacts(
    {
      id: mail.id,
      sourceId: mail.id,
      sourceThreadId: mail.id,
      accountId: EVAL_ACCOUNT_ID,
      title: mail.subject,
      content: mail.body,
      authoredAt: mail.authoredAt,
      raw: storedGmailMessage(mail),
      metadata: { from: mail.from, labelIds: [...mail.labelIds] },
    },
    {
      timezone: EVAL_TIMEZONE,
      mailboxByAccountId: new Map([[EVAL_ACCOUNT_ID, EVAL_MAILBOX]]),
      knownContacts: new Set(mail.knownContact && senderAddress ? [senderAddress] : []),
      ownReplies: [],
    },
  );
}
