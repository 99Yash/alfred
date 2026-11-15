/**
 * The mail facts (`docs/theory/triage.md` § The mail facts): what one stored Gmail message
 * says about itself, read from `documents.raw` by code. A reader, not a verdict. Triage reads
 * its prompt input only from here.
 */

import {
  collapseWhitespace,
  extractGmailDocumentBody,
  isSentGmailMetadata,
  parseGmailDocumentMetadata,
  parseIanaTimezone,
  type GmailDocumentMetadata,
  type IanaTimezone,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents, type Document } from "@alfred/db/schemas";
import {
  extractAttachments,
  extractMessageContent,
  parseStoredGmailMessage,
} from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import { and, eq, inArray, sql } from "drizzle-orm";
import { settings, userIdentity, type UserIdentity } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import {
  gmailHeaderLookup,
  internalDateFromMessage,
  parseAddressList,
  parseSingleAddress,
  type GmailHeaderLookup,
  type ParsedAddress,
  type ParsedAddressList,
} from "./gmail-reducer";
import { extractSenderContext, type SenderContextResult } from "./sender-context";
import { knownContactAddresses } from "./significance";

/** The body cap. Past it the body ends in `"\n[…truncated]"`. */
export const MAIL_FACTS_BODY_MAX_CHARS = 6_000;

/** The user's own replies in the thread that the reader keeps, newest first. */
const OWN_REPLY_LIMIT = 3;

const OWN_REPLY_MAX_CHARS = 500;

/** Values kept per `stated` field. */
const STATED_MAX_VALUES = 5;

const STATED_MAX_VALUE_CHARS = 120;

const STATED_SCAN_LINES = 200;

type RecipientRole = ParsedAddressList["role"];

const RECIPIENT_ROLES = ["to", "cc", "bcc"] as const satisfies readonly RecipientRole[];

export interface MailRecipient {
  readonly address: string;
  readonly displayName: string | null;
  /** One of the user's own addresses. Never also a known contact. */
  readonly isUser: boolean;
  /**
   * A `person` row in `entities` holds the address as an alias. The sender's `Known contact:`
   * observation reads the same aliases (`readSenderPerson`). The people-graph step replaces
   * both with one reader.
   */
  readonly knownContact: boolean;
}

export interface MailOwnReply {
  readonly at: Date | null;
  readonly text: string;
}

export interface MailFacts {
  readonly documentId: string;
  /** `documents.source_id`. */
  readonly messageId: string;
  /** `documents.source_thread_id`. */
  readonly threadId: string | null;
  /**
   * Arrival time in the user's zone: the wall clock with its year (`2026-10-19 13:30`), the
   * short weekday (`Mon`), and the zone name. A deadline in the mail resolves against the year.
   */
  readonly arrivedAt: {
    readonly at: Date;
    readonly local: string;
    readonly weekday: string;
    readonly timezone: string;
  } | null;
  readonly sender: {
    /** The parse's own address (`metadata.from`), else the raw `From` header's. */
    readonly address: string | null;
    readonly displayName: string | null;
    /** The address is one of the user's own addresses. */
    readonly isUser: boolean;
    /** `extractSenderContext` as the classify step ran it: the context, the parser, the address. */
    readonly parse: SenderContextResult;
  };
  /** The header value, trimmed. */
  readonly replyTo: string | null;
  /** Null = the header is absent; [] = present and empty. One entry per parsed address. */
  readonly to: readonly MailRecipient[] | null;
  readonly cc: readonly MailRecipient[] | null;
  readonly bcc: readonly MailRecipient[] | null;
  /** The user's own mailbox address that got the mail (accountId → address). */
  readonly receivedBy: string | null;
  readonly subject: string | null;
  /** Plain body, capped at MAIL_FACTS_BODY_MAX_CHARS with "\n[…truncated]". */
  readonly body: string;
  /** The user's own replies in this thread up to this mail, newest first, quoted history removed. */
  readonly ownReplies: readonly MailOwnReply[];
  /** Copied from labelled body lines, in the mail's own words. */
  readonly stated: {
    readonly devices: readonly string[];
    readonly places: readonly string[];
    readonly apps: readonly string[];
  };
  readonly labelIds: readonly string[];
  /** `labelIds` includes "SPAM". */
  readonly spam: boolean;
  readonly hasAttachments: boolean;
  /** Kept for the DMARC check (ADR-0122 1a). Not rendered into the triage prompt. */
  readonly authenticationResults: string | null;
}

/** The stored row the reader reads. `raw` and `metadata` stay `unknown`: the reader parses them. */
export type MailFactsRow = Pick<
  Document,
  "id" | "sourceId" | "sourceThreadId" | "accountId" | "title" | "content" | "authoredAt"
> & { readonly raw: unknown; readonly metadata: unknown };

export interface MailFactsContext {
  readonly timezone: IanaTimezone;
  readonly mailboxByAccountId: ReadonlyMap<string, string>;
  /** The user's own addresses (`UserIdentity.emails`). */
  readonly userAddresses: ReadonlySet<string>;
  /** Lowercased addresses. */
  readonly knownContacts: ReadonlySet<string>;
  readonly ownReplies: MailFacts["ownReplies"];
}

/** The labelled-line vocabulary of `stated`. Lowercase; matched case-insensitively. */
const STATED_LABELS = [
  ["devices", ["device", "device name", "browser", "operating system", "os", "platform"]],
  ["places", ["location", "approximate location", "country", "country/region", "region", "city"]],
  ["apps", ["app", "application", "client"]],
] as const satisfies readonly (readonly [keyof MailFacts["stated"], readonly string[]])[];

const STATED_FIELD_BY_LABEL: ReadonlyMap<string, keyof MailFacts["stated"]> = new Map(
  STATED_LABELS.flatMap(([field, labels]) => labels.map((label) => [label, field] as const)),
);

const STATED_LINE_RE = /^\s*([A-Za-z][A-Za-z /]*?)\s*:\s*(.*?)\s*$/;

/** One parse of a stored row: every fact that needs no lookup. */
interface ParsedMail {
  readonly row: MailFactsRow;
  readonly headers: GmailHeaderLookup;
  readonly sender: Omit<MailFacts["sender"], "isUser">;
  readonly recipients: Readonly<Record<RecipientRole, readonly ParsedAddress[] | null>>;
  readonly subject: string | null;
  readonly fullBody: string;
  readonly at: Date | null;
  readonly labelIds: readonly string[];
  readonly hasAttachments: boolean;
}

function parseMail(row: MailFactsRow): ParsedMail {
  const message = parseStoredGmailMessage(row.raw);
  const headers = gmailHeaderLookup(message?.payload?.headers);
  const metadata = parseGmailDocumentMetadata(row.metadata);

  // The same inputs the live classify step gave the parse before this reader: the stored
  // `metadata.from`, the title, and the stored content with its envelope lines. A body parser
  // can read an envelope line (a Linear subject), so the sender parse does not change here.
  const parse = extractSenderContext({
    fromHeader: metadata.from ?? null,
    subject: row.title,
    body: row.content,
  });

  // The address and the name come from the string the parse read; the raw header is a fallback.
  const mailbox =
    parseSingleAddress(metadata.from ?? null) ?? parseSingleAddress(headers.get("from"));

  const fullBody = message
    ? extractMessageContent(message).body
    : extractGmailDocumentBody(row.content, {
        from: metadata.from,
        to: metadata.to,
        cc: metadata.cc,
        subject: row.title,
      });

  const recipients = (role: RecipientRole) => {
    const raw = recipientHeader(headers, metadata, role);

    return raw === null ? null : parseAddressList(raw, role).parsed;
  };

  return {
    row,
    headers,
    sender: {
      address: parse.senderAddress ?? mailbox?.identity.value ?? null,
      displayName: mailbox?.displayName ?? null,
      parse,
    },
    recipients: { to: recipients("to"), cc: recipients("cc"), bcc: recipients("bcc") },
    subject: headers.get("subject") ?? trimmedOrNull(row.title),
    fullBody,
    at: row.authoredAt ?? internalDateFromMessage(message),
    labelIds: metadata.labelIds ?? message?.labelIds ?? [],
    hasAttachments: message ? extractAttachments(message).length > 0 : false,
  };
}

/** The sender and every recipient address of a parse, for the one known-contact read. */
function mailAddresses(parsed: ParsedMail): string[] {
  const recipients = RECIPIENT_ROLES.flatMap((role) => parsed.recipients[role] ?? []);

  return [
    ...(parsed.sender.address ? [parsed.sender.address] : []),
    ...recipients.map((address) => address.identity.value),
  ];
}

function finishMailFacts(parsed: ParsedMail, ctx: MailFactsContext): MailFacts {
  const { row, headers, labelIds } = parsed;

  const recipients = (role: RecipientRole): MailRecipient[] | null =>
    parsed.recipients[role]?.map((address) => {
      const isUser = ctx.userAddresses.has(address.identity.value);

      return {
        address: address.identity.value,
        displayName: address.displayName ?? null,
        isUser,
        knownContact: !isUser && ctx.knownContacts.has(address.identity.value),
      };
    }) ?? null;

  return {
    documentId: row.id,
    messageId: row.sourceId,
    threadId: row.sourceThreadId,
    arrivedAt: parsed.at ? arrivalOf(parsed.at, ctx.timezone) : null,
    sender: {
      ...parsed.sender,
      isUser: parsed.sender.address !== null && ctx.userAddresses.has(parsed.sender.address),
    },
    replyTo: headers.get("reply-to"),
    to: recipients("to"),
    cc: recipients("cc"),
    bcc: recipients("bcc"),
    receivedBy: row.accountId ? (ctx.mailboxByAccountId.get(row.accountId) ?? null) : null,
    subject: parsed.subject,
    body: capBody(parsed.fullBody),
    ownReplies: ctx.ownReplies,
    stated: readStated(parsed.fullBody),
    labelIds,
    spam: labelIds.includes("SPAM"),
    hasAttachments: parsed.hasAttachments,
    authenticationResults: headers.get("authentication-results"),
  };
}

/** The mail facts of one stored Gmail row. Pure: every lookup comes in `ctx`. */
export function readMailFacts(row: MailFactsRow, ctx: MailFactsContext): MailFacts {
  return finishMailFacts(parseMail(row), ctx);
}

/** The arrival with its year: `2026-10-19 13:30`, `Mon`, and the zone. */
function arrivalOf(at: Date, timezone: IanaTimezone): NonNullable<MailFacts["arrivedAt"]> {
  const clock = inZone(timezone).clock(at);

  return {
    at,
    local: `${clock.localDate} ${clock.localTime.slice(0, 5)}`,
    weekday: clock.weekday.slice(0, 3),
    timezone,
  };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

/**
 * A recipient header: the raw header when present, else the stored metadata value, as the
 * reducer reads it. Null when neither has it; `""` when it is present and empty.
 */
function recipientHeader(
  headers: GmailHeaderLookup,
  metadata: GmailDocumentMetadata,
  role: RecipientRole,
): string | null {
  if (headers.has(role)) return headers.get(role) ?? "";

  if (role === "bcc") return null;

  return metadata[role] ?? null;
}

function capBody(body: string): string {
  return body.length > MAIL_FACTS_BODY_MAX_CHARS
    ? body.slice(0, MAIL_FACTS_BODY_MAX_CHARS) + "\n[…truncated]"
    : body;
}

/** Labelled `Label: value` lines, copied verbatim. A name said only in a sentence stays in the body. */
function readStated(body: string): MailFacts["stated"] {
  const stated = {
    devices: new Array<string>(),
    places: new Array<string>(),
    apps: new Array<string>(),
  };

  for (const line of body.split(/\r?\n/, STATED_SCAN_LINES)) {
    const match = STATED_LINE_RE.exec(line);
    const field = match?.[1] ? STATED_FIELD_BY_LABEL.get(match[1].toLowerCase()) : undefined;
    const value = match?.[2];

    if (!field || !value || value.length > STATED_MAX_VALUE_CHARS) continue;

    const values = stated[field];

    if (values.length < STATED_MAX_VALUES && !values.includes(value)) values.push(value);
  }

  return stated;
}

const QUOTE_HEADER_RE = /^On .+ wrote:$/;

/** The user's own words in a reply: quoted lines and the quoted history dropped. */
function ownReplyText(body: string): string {
  const kept: string[] = [];

  for (const line of body.split(/\r?\n/)) {
    if (QUOTE_HEADER_RE.test(line.trim())) break;

    if (line.trimStart().startsWith(">")) continue;
    kept.push(line);
  }

  const text = collapseWhitespace(kept.join("\n"));

  return text.length > OWN_REPLY_MAX_CHARS
    ? `${text.slice(0, OWN_REPLY_MAX_CHARS).trimEnd()}…`
    : text;
}

const UTC = parseIanaTimezone("UTC");

/**
 * The mail facts of stored Gmail rows, keyed by document id. A missing id has no entry.
 * Every lookup is best-effort: a failed read gives its empty value (UTC for the zone) and a
 * warning.
 */
export async function loadMailFacts(
  userId: string,
  documentIds: readonly string[],
): Promise<Map<string, MailFacts>> {
  const out = new Map<string, MailFacts>();

  if (documentIds.length === 0) return out;

  const rows = await db()
    .select({
      id: documents.id,
      sourceId: documents.sourceId,
      sourceThreadId: documents.sourceThreadId,
      accountId: documents.accountId,
      title: documents.title,
      content: documents.content,
      authoredAt: documents.authoredAt,
      raw: documents.raw,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.source, "gmail"),
        inArray(documents.id, [...documentIds]),
      ),
    );

  if (rows.length === 0) return out;

  // Each row is parsed one time; the lookups then finish the facts.
  const parsed = rows.map(parseMail);

  const bestEffort = <T>(what: string, read: Promise<T>, fallback: T): Promise<T> =>
    read.catch((err: unknown) => {
      logger.warn({ err, userId }, `[knowledge.mail-facts] ${what} read failed`);

      return fallback;
    });

  const noIdentity: Pick<UserIdentity, "mailboxByAccountId" | "emails"> = {
    mailboxByAccountId: new Map(),
    emails: new Set(),
  };

  const [identity, timezone, knownContacts, ownReplies] = await Promise.all([
    bestEffort("user identity", userIdentity({ userId }), noIdentity),
    bestEffort("timezone", settings({ userId }).timezone(), UTC),
    bestEffort(
      "known-contact",
      knownContactAddresses(userId, [...new Set(parsed.flatMap(mailAddresses))]),
      new Set<string>(),
    ),
    bestEffort("own-reply", readOwnReplies(userId, rows), new Map<string, MailOwnReply[]>()),
  ]);

  for (const mail of parsed) {
    out.set(
      mail.row.id,
      finishMailFacts(mail, {
        timezone,
        mailboxByAccountId: identity.mailboxByAccountId,
        userAddresses: identity.emails,
        knownContacts,
        ownReplies: ownReplies.get(mail.row.id) ?? [],
      }),
    );
  }

  return out;
}

/**
 * The user's sent messages in each row's thread up to its arrival, newest first.
 * Metadata first, then bodies only for the kept replies.
 */
async function readOwnReplies(
  userId: string,
  rows: readonly Pick<MailFactsRow, "id" | "sourceThreadId" | "authoredAt">[],
): Promise<Map<string, MailOwnReply[]>> {
  const out = new Map<string, MailOwnReply[]>();
  const threadIds = [...new Set(rows.flatMap((row) => row.sourceThreadId ?? []))];

  if (threadIds.length === 0) return out;

  const threadWhere = and(
    eq(documents.userId, userId),
    eq(documents.source, "gmail"),
    inArray(documents.sourceThreadId, threadIds),
  );

  const newestFirst = sql`${documents.authoredAt} desc nulls last, ${documents.id} desc`;

  const siblings = await db()
    .select({
      id: documents.id,
      sourceThreadId: documents.sourceThreadId,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(threadWhere)
    .orderBy(newestFirst);

  const sentByThread = new Map<string, { id: string; authoredAt: Date | null }[]>();

  for (const sibling of siblings) {
    if (!sibling.sourceThreadId) continue;

    if (!isSentGmailMetadata(parseGmailDocumentMetadata(sibling.metadata))) continue;
    const sent = sentByThread.get(sibling.sourceThreadId) ?? [];
    sent.push({ id: sibling.id, authoredAt: sibling.authoredAt });
    sentByThread.set(sibling.sourceThreadId, sent);
  }

  // Per row: the newest sent messages at or before its arrival, without the row itself. A row
  // with no time keeps every sent message; a sent message with no time is out of order, so out.
  const keptByRow = new Map<string, string[]>();

  for (const row of rows) {
    const sent = row.sourceThreadId ? (sentByThread.get(row.sourceThreadId) ?? []) : [];
    const arrived = row.authoredAt;

    const kept = sent.filter(
      (reply) =>
        reply.id !== row.id &&
        (arrived === null || (reply.authoredAt !== null && reply.authoredAt <= arrived)),
    );

    keptByRow.set(
      row.id,
      kept.slice(0, OWN_REPLY_LIMIT).map((reply) => reply.id),
    );
  }

  const bodyIds = [...new Set([...keptByRow.values()].flat())];

  if (bodyIds.length === 0) return out;

  const bodies = await db()
    .select({
      id: documents.id,
      title: documents.title,
      content: documents.content,
      authoredAt: documents.authoredAt,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(and(threadWhere, inArray(documents.id, bodyIds)));

  const replyById = new Map<string, MailOwnReply>();

  for (const body of bodies) {
    const metadata = parseGmailDocumentMetadata(body.metadata);

    const text = ownReplyText(
      extractGmailDocumentBody(body.content, {
        from: metadata.from,
        to: metadata.to,
        cc: metadata.cc,
        subject: body.title,
      }),
    );

    if (text) replyById.set(body.id, { at: body.authoredAt, text });
  }

  for (const [rowId, ids] of keptByRow) {
    out.set(
      rowId,
      ids.flatMap((id) => replyById.get(id) ?? []),
    );
  }

  return out;
}
