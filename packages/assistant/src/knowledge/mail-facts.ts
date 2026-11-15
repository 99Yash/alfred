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
  type SenderContext,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { documents } from "@alfred/db/schemas";
import {
  extractAttachments,
  extractMessageContent,
  parseStoredGmailMessage,
} from "@alfred/integrations/google";
import { logger } from "@alfred/logging";
import { and, eq, inArray, sql } from "drizzle-orm";
import { settings, userIdentity } from "@alfred/assistant/settings";
import { inZone } from "@alfred/assistant/time";
import {
  gmailHeaderLookup,
  internalDateFromMessage,
  parseAddressList,
  parseSingleAddress,
  type GmailHeaderLookup,
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

export interface MailRecipient {
  readonly address: string;
  readonly displayName: string | null;
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
    readonly address: string | null;
    readonly displayName: string | null;
    /** `extractSenderContext`; `effectiveAuthor` lives here. */
    readonly context: SenderContext;
    /** Which body parser named the actor. The triage decision trace records it. */
    readonly parserHit: SenderContextResult["parserHit"];
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
  /** The user's own replies in this thread, newest first, quoted history removed. */
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

/** The stored row the pure reader reads. */
export interface MailFactsRow {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceThreadId: string | null;
  readonly accountId: string | null;
  readonly title: string | null;
  readonly content: string;
  readonly authoredAt: Date | null;
  readonly raw: unknown;
  readonly metadata: unknown;
}

export interface MailFactsContext {
  readonly timezone: IanaTimezone;
  readonly mailboxByAccountId: ReadonlyMap<string, string>;
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

/** The mail facts of one stored Gmail row. Pure: every lookup comes in `ctx`. */
export function readMailFacts(row: MailFactsRow, ctx: MailFactsContext): MailFacts {
  const message = parseStoredGmailMessage(row.raw);
  const headers = gmailHeaderLookup(message?.payload?.headers);
  const metadata = parseGmailDocumentMetadata(row.metadata);

  const fromRaw = headers.get("from") ?? trimmedOrNull(metadata.from);
  const sender = parseSingleAddress(fromRaw);
  const subject = headers.get("subject") ?? trimmedOrNull(row.title);

  const fullBody = message
    ? extractMessageContent(message).body
    : extractGmailDocumentBody(row.content, {
        from: metadata.from,
        to: metadata.to,
        cc: metadata.cc,
        subject: row.title,
      });

  // The same inputs the live classify step gave the parse before this reader: the stored
  // `metadata.from`, the title, and the stored content with its envelope lines. A body parser
  // can read an envelope line (a Linear subject), so the sender parse does not change here.
  const senderParse = extractSenderContext({
    fromHeader: metadata.from ?? null,
    subject: row.title,
    body: row.content,
  });

  const at = row.authoredAt ?? internalDateFromMessage(message);
  const labelIds = metadata.labelIds ?? message?.labelIds ?? [];

  const recipients = (name: "to" | "cc" | "bcc") =>
    readRecipients(recipientHeader(headers, metadata, name), name, ctx.knownContacts);

  return {
    documentId: row.id,
    messageId: row.sourceId,
    threadId: row.sourceThreadId,
    arrivedAt: at ? arrivalOf(at, ctx.timezone) : null,
    sender: {
      address: sender?.identity.value ?? null,
      displayName: sender?.displayName ?? null,
      context: senderParse.context,
      parserHit: senderParse.parserHit,
    },
    replyTo: headers.get("reply-to"),
    to: recipients("to"),
    cc: recipients("cc"),
    bcc: recipients("bcc"),
    receivedBy: row.accountId ? (ctx.mailboxByAccountId.get(row.accountId) ?? null) : null,
    subject,
    body: capBody(fullBody),
    ownReplies: ctx.ownReplies,
    stated: readStated(fullBody),
    labelIds,
    spam: labelIds.includes("SPAM"),
    hasAttachments: message ? extractAttachments(message).length > 0 : false,
    authenticationResults: headers.get("authentication-results"),
  };
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
  name: "to" | "cc" | "bcc",
): string | null {
  if (headers.has(name)) return headers.get(name) ?? "";

  if (name === "bcc") return null;

  return metadata[name] ?? null;
}

function readRecipients(
  raw: string | null,
  role: "to" | "cc" | "bcc",
  knownContacts: ReadonlySet<string>,
): MailRecipient[] | null {
  if (raw === null) return null;

  return parseAddressList(raw, role).parsed.map((address) => ({
    address: address.identity.value,
    displayName: address.displayName ?? null,
    knownContact: knownContacts.has(address.identity.value.toLowerCase()),
  }));
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

/**
 * The mail facts of stored Gmail rows, keyed by document id. A missing id has no entry.
 * Every lookup is best-effort: a failed read gives its empty value and a warning.
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

  // The addresses come from the same parse the reader makes, so both sides agree.
  const addresses = new Set<string>();

  for (const row of rows) {
    const facts = readMailFacts(row, EMPTY_LOOKUPS);

    if (facts.sender.address) addresses.add(facts.sender.address);

    for (const list of [facts.to, facts.cc, facts.bcc]) {
      for (const recipient of list ?? []) addresses.add(recipient.address);
    }
  }

  const [identity, timezone, knownContacts, ownReplies] = await Promise.all([
    userIdentity({ userId }),
    settings({ userId }).timezone(),
    knownContactAddresses(userId, [...addresses]).catch((err: unknown) => {
      logger.warn({ err, userId }, "[knowledge.mail-facts] known-contact read failed");

      return new Set<string>();
    }),
    readOwnReplies(userId, rows).catch((err: unknown) => {
      logger.warn({ err, userId }, "[knowledge.mail-facts] own-reply read failed");

      return new Map<string, MailOwnReply[]>();
    }),
  ]);

  for (const row of rows) {
    out.set(
      row.id,
      readMailFacts(row, {
        timezone,
        mailboxByAccountId: identity.mailboxByAccountId,
        knownContacts,
        ownReplies: ownReplies.get(row.id) ?? [],
      }),
    );
  }

  return out;
}

/** The lookups of a first parse that only collects addresses. */
const EMPTY_LOOKUPS: MailFactsContext = {
  timezone: parseIanaTimezone("UTC"),
  mailboxByAccountId: new Map(),
  knownContacts: new Set(),
  ownReplies: [],
};

/**
 * The user's sent messages in each row's thread, newest first, without the row itself.
 * Metadata first, then bodies only for the kept replies.
 */
async function readOwnReplies(
  userId: string,
  rows: readonly { id: string; sourceThreadId: string | null }[],
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
      metadata: documents.metadata,
    })
    .from(documents)
    .where(threadWhere)
    .orderBy(newestFirst);

  const sentByThread = new Map<string, string[]>();

  for (const sibling of siblings) {
    if (!sibling.sourceThreadId) continue;

    if (!isSentGmailMetadata(parseGmailDocumentMetadata(sibling.metadata))) continue;
    const ids = sentByThread.get(sibling.sourceThreadId) ?? [];
    ids.push(sibling.id);
    sentByThread.set(sibling.sourceThreadId, ids);
  }

  // Per row: the newest sent messages that are not the row itself.
  const keptByRow = new Map<string, string[]>();

  for (const row of rows) {
    const sent = row.sourceThreadId ? (sentByThread.get(row.sourceThreadId) ?? []) : [];
    keptByRow.set(row.id, sent.filter((id) => id !== row.id).slice(0, OWN_REPLY_LIMIT));
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
