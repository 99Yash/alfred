import {
  getStringPath,
  gmailEmailMessagePayloadSchema,
  observationInsertSchema,
  parseEmailIdentity,
  parseGmailDocumentMetadata,
  parseMailbox,
  splitAddressList,
  type GmailDocumentMetadata,
  type GmailEmailMessagePayload,
  type IdentityRef,
  type JsonValue,
  type ObservationInsertInput,
  type ObservationParticipant,
  type ObservationParticipantRole,
} from "@alfred/contracts";
import { sha256Canonical, sha256Hex } from "@alfred/db/hash";
import { parseStoredGmailMessage, type GmailMessage } from "@alfred/integrations/google";
import type { GmailPayloadSignals } from "./entity-kind-classifier";

const GMAIL_REDUCER_VERSION = 1;

const UNKNOWN_ACCOUNT_FAMILY_KEY_PART = "unknown-account";

const SENT_LABEL = "SENT";

export interface GmailDocumentForReduction {
  readonly id: string;
  readonly userId: string;
  readonly sourceId: string;
  readonly sourceThreadId: string | null;
  readonly accountId: string | null;
  readonly title: string | null;
  readonly authoredAt: Date | null;
  readonly raw: unknown;
  readonly metadata: unknown;
}

export interface GmailReductionIssue {
  readonly documentId: string;
  readonly severity: "skip" | "warn";
  readonly code: string;
  readonly message: string;
}

export interface GmailReductionResult {
  readonly observations: ObservationInsertInput[];
  readonly issues: GmailReductionIssue[];
}

interface ParsedAddress {
  readonly identity: IdentityRef;
  readonly displayName?: string;
  readonly raw: string;
}

interface HeaderLookup {
  readonly get: (name: string) => string | null;
}

export function reduceGmailDocument(row: GmailDocumentForReduction): GmailReductionResult {
  const issues: GmailReductionIssue[] = [];
  // One parse of `documents.raw`; a row that is not a Gmail message falls back to metadata.
  const message = parseStoredGmailMessage(row.raw);
  const headers = headersFromList(message?.payload?.headers);
  const metadata = parseGmailDocumentMetadata(row.metadata);

  const occurredAt = row.authoredAt ?? internalDateFromMessage(message);

  if (!occurredAt) {
    return skip(row.id, "missing_occurred_at", "Gmail document has no authoredAt/internalDate");
  }

  const fromRaw = headerOrMetadata(headers, metadata, "from");
  const sender = parseSingleAddress(fromRaw);

  if (!sender) {
    return skip(row.id, "missing_sender", "Gmail document has no parseable From header");
  }

  const isSent = isSentMessage(message, metadata);
  const subject = firstNonEmpty(headers.get("subject"), row.title);
  const listId = normalizeHeader(headers.get("list-id"));

  const participants = buildParticipants({
    from: sender,
    to: parseAddressList(headerOrMetadata(headers, metadata, "to"), "to"),
    cc: parseAddressList(headerOrMetadata(headers, metadata, "cc"), "cc"),
    bcc: parseAddressList(headers.get("bcc"), "bcc"),
    listId,
  });

  if (participants.droppedAddressCount > 0) {
    issues.push({
      documentId: row.id,
      severity: "warn",
      code: "dropped_unparseable_recipient",
      message: `Dropped ${participants.droppedAddressCount} unparseable recipient address(es)`,
    });
  }

  const payload = gmailEmailMessagePayloadSchema.parse({
    provider: "gmail",
    documentId: row.id,
    messageId: row.sourceId,
    threadId: row.sourceThreadId,
    accountId: row.accountId,
    isSent,
    subject,
    subjectHash: subject ? `sha256:${sha256Hex(subject)}` : null,
    headers: {
      messageId: normalizeHeader(headers.get("message-id")),
      inReplyTo: normalizeHeader(headers.get("in-reply-to")),
      references: parseReferences(headers.get("references")),
      listId,
      listUnsubscribe: normalizeHeader(headers.get("list-unsubscribe")),
      replyTo: normalizeHeader(headers.get("reply-to")),
      deliveredTo: normalizeHeader(headers.get("delivered-to")),
      autoSubmitted: normalizeHeader(headers.get("auto-submitted")),
      precedence: normalizeHeader(headers.get("precedence")),
    },
  } satisfies GmailEmailMessagePayload);

  const input: ObservationInsertInput = {
    userId: row.userId,
    source: "gmail",
    kind: "email_message",
    occurredAt,
    familyKey: `gmail:message:${row.accountId ?? UNKNOWN_ACCOUNT_FAMILY_KEY_PART}:${row.sourceId}`,
    evidenceHash: sha256Canonical({
      participants: participants.items.map(canonicalParticipantForHash),
      recipientCount: participants.recipientCount,
      isSent,
      occurredAt: occurredAt.toISOString(),
      listId,
      listUnsubscribe: payload.headers.listUnsubscribe,
      inReplyTo: payload.headers.inReplyTo,
      references: payload.headers.references,
    }),
    subjectIdentity: sender.identity,
    objectIdentity: null,
    participants: {
      items: participants.items,
      recipientCount: participants.recipientCount,
      ...(listId ? { listId } : {}),
    },
    payload,
    schemaVersion: 1,
    reducerVersion: GMAIL_REDUCER_VERSION,
  };

  observationInsertSchema.parse(input);

  return { observations: [input], issues };
}

function skip(documentId: string, code: string, message: string): GmailReductionResult {
  return {
    observations: [],
    issues: [{ documentId, severity: "skip", code, message }],
  };
}

/** List/bulk signals from a raw `payload.headers` array, so a scan never loads bodies (#1198). */
export function gmailPayloadSignalsFromHeaders(headers: unknown): GmailPayloadSignals {
  const lookup = headersFromList(headers);

  return {
    listId: lookup.get("list-id"),
    listUnsubscribe: lookup.get("list-unsubscribe"),
    precedence: lookup.get("precedence"),
    autoSubmitted: lookup.get("auto-submitted"),
  };
}

function headersFromList(headers: unknown): HeaderLookup {
  const out = new Map<string, string>();

  if (!Array.isArray(headers)) {
    return { get: () => null };
  }

  for (const h of headers) {
    const name = getStringPath(h, "name");
    const value = getStringPath(h, "value");

    if (name === undefined || value === undefined) continue;
    const key = name.trim().toLowerCase();

    if (key && !out.has(key)) out.set(key, value);
  }

  return { get: (name) => normalizeHeader(out.get(name.toLowerCase()) ?? null) };
}

function headerOrMetadata(
  headers: HeaderLookup,
  metadata: GmailDocumentMetadata,
  name: "from" | "to" | "cc",
): string | null {
  return headers.get(name) ?? normalizeHeader(metadata[name]);
}

function normalizeHeader(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function firstNonEmpty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    const normalized = normalizeHeader(value);

    if (normalized) return normalized;
  }

  return null;
}

function internalDateFromMessage(message: GmailMessage | null): Date | null {
  const value = message?.internalDate;

  if (value === undefined) return null;
  const ms = Number(value);

  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);

  return Number.isNaN(date.getTime()) ? null : date;
}

function isSentMessage(message: GmailMessage | null, metadata: GmailDocumentMetadata): boolean {
  if (metadata.isSent === true) return true;

  if (message?.labelIds?.some((label) => label === SENT_LABEL) === true) return true;

  return metadata.labelIds?.some((label) => label === SENT_LABEL) === true;
}

interface ParsedAddressList {
  parsed: ParsedAddress[];
  role: Extract<ObservationParticipantRole, "to" | "cc" | "bcc">;
  dropped: number;
}

function parseAddressList(raw: string | null, role: ParsedAddressList["role"]): ParsedAddressList {
  if (!raw) return { parsed: [], role, dropped: 0 };
  let dropped = 0;
  const parsed: ParsedAddress[] = [];

  for (const segment of splitAddressList(raw)) {
    const address = parseSingleAddress(segment);

    if (address) parsed.push(address);
    else dropped++;
  }

  return { parsed, role, dropped };
}

function parseSingleAddress(raw: string | null): ParsedAddress | null {
  const normalized = normalizeHeader(raw);
  const mailbox = parseMailbox(normalized);
  const value = parseEmailIdentity(mailbox?.address);

  if (!normalized || !mailbox || !value) return null;

  return {
    identity: { kind: "email", value },
    ...(mailbox.displayName ? { displayName: mailbox.displayName } : {}),
    raw: normalized,
  };
}

interface BuiltParticipants {
  readonly items: ObservationParticipant[];
  readonly recipientCount: number;
  readonly droppedAddressCount: number;
}

function buildParticipants(args: {
  readonly from: ParsedAddress;
  readonly to: ReturnType<typeof parseAddressList>;
  readonly cc: ReturnType<typeof parseAddressList>;
  readonly bcc: ReturnType<typeof parseAddressList>;
  readonly listId: string | null;
}): BuiltParticipants {
  const items: ObservationParticipant[] = [toParticipant(args.from, "from")];
  const recipientIdentities = new Set<string>();
  let droppedAddressCount = 0;

  for (const group of [args.to, args.cc, args.bcc]) {
    droppedAddressCount += group.dropped;

    for (const address of group.parsed) {
      items.push(toParticipant(address, group.role));
      recipientIdentities.add(`${address.identity.kind}\u0000${address.identity.value}`);
    }
  }

  return {
    items: dedupeParticipants(items),
    recipientCount: recipientIdentities.size,
    droppedAddressCount,
  };
}

function toParticipant(
  address: ParsedAddress,
  role: ObservationParticipantRole,
): ObservationParticipant {
  return {
    identity: address.identity,
    role,
    ...(address.displayName ? { displayName: address.displayName } : {}),
    raw: address.raw,
  };
}

function dedupeParticipants(items: readonly ObservationParticipant[]): ObservationParticipant[] {
  const seen = new Set<string>();
  const out: ObservationParticipant[] = [];

  for (const item of items) {
    const key = `${item.role}\u0000${item.identity.kind}\u0000${item.identity.value}`;

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function parseReferences(raw: string | null): string[] {
  const normalized = normalizeHeader(raw);

  if (!normalized) return [];

  return normalized
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function canonicalParticipantForHash(participant: ObservationParticipant): JsonValue {
  return {
    identity: participant.identity,
    role: participant.role,
    displayName: participant.displayName ?? null,
    raw: participant.raw ?? null,
  };
}
