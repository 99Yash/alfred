import { createHash } from "node:crypto";
import {
  canonicalizeIdentityValue,
  getPath,
  gmailEmailMessagePayloadSchema,
  identityRefSchema,
  isRecord,
  observationInsertSchema,
  type GmailEmailMessagePayload,
  type IdentityRef,
  type JsonValue,
  type ObservationInsertInput,
  type ObservationParticipant,
  type ObservationParticipantRole,
} from "@alfred/contracts";

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
  const headers = headersFromRaw(row.raw);
  const metadata = isRecord(row.metadata) ? row.metadata : {};

  const occurredAt = row.authoredAt ?? internalDateFromRaw(row.raw);
  if (!occurredAt) {
    return skip(row.id, "missing_occurred_at", "Gmail document has no authoredAt/internalDate");
  }

  const fromRaw = headerOrMetadata(headers, metadata, "from");
  const sender = parseSingleAddress(fromRaw);
  if (!sender) {
    return skip(row.id, "missing_sender", "Gmail document has no parseable From header");
  }

  const isSent = isSentMessage(row.raw, metadata);
  const subject = firstNonEmpty(headers.get("subject"), row.title);
  const listId = normalizeHeader(headers.get("list-id"));
  const participants = buildParticipants({
    from: sender,
    to: parseAddressList(headerOrMetadata(headers, metadata, "to"), "to"),
    cc: parseAddressList(headerOrMetadata(headers, metadata, "cc"), "cc"),
    bcc: parseAddressList(headerOrMetadata(headers, metadata, "bcc"), "bcc"),
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
    subjectHash: subject ? `sha256:${sha256(subject)}` : null,
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
    evidenceHash: buildEvidenceHash({
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

function headersFromRaw(raw: unknown): HeaderLookup {
  const out = new Map<string, string>();
  const headers = getPath(raw, "payload", "headers");
  if (!Array.isArray(headers)) {
    return { get: () => null };
  }
  for (const h of headers) {
    if (!isRecord(h) || typeof h.name !== "string" || typeof h.value !== "string") continue;
    const key = h.name.trim().toLowerCase();
    if (key && !out.has(key)) out.set(key, h.value);
  }
  return { get: (name) => normalizeHeader(out.get(name.toLowerCase()) ?? null) };
}

function headerOrMetadata(
  headers: HeaderLookup,
  metadata: Record<string, unknown>,
  name: string,
): string | null {
  return headers.get(name) ?? normalizeHeader(metadata[name]);
}

function normalizeHeader(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstNonEmpty(...values: readonly unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeHeader(value);
    if (normalized) return normalized;
  }
  return null;
}

function internalDateFromRaw(raw: unknown): Date | null {
  const value = getPath(raw, "internalDate");
  if (typeof value !== "string") return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSentMessage(raw: unknown, metadata: Record<string, unknown>): boolean {
  if (metadata.isSent === true) return true;
  const rawLabelIds = getPath(raw, "labelIds");
  if (Array.isArray(rawLabelIds) && rawLabelIds.some((label) => label === SENT_LABEL)) return true;
  const metadataLabelIds = metadata.labelIds;
  return Array.isArray(metadataLabelIds) && metadataLabelIds.some((label) => label === SENT_LABEL);
}

function parseAddressList(
  raw: string | null,
  role: Extract<ObservationParticipantRole, "to" | "cc" | "bcc">,
): { parsed: ParsedAddress[]; role: typeof role; dropped: number } {
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
  if (!normalized) return null;

  const angle = /^(.*?)<([^>]+)>\s*$/.exec(normalized);
  const addressRaw = (angle?.[2] ?? normalized).trim();
  const displayNameRaw = angle?.[1]?.trim();
  const displayName = displayNameRaw ? stripOuterQuotes(displayNameRaw) : undefined;
  const value = canonicalizeIdentityValue("email", addressRaw);
  const identity = identityRefSchema.safeParse({ kind: "email", value });
  if (!identity.success) return null;
  return {
    identity: identity.data,
    ...(displayName ? { displayName } : {}),
    raw: normalized,
  };
}

function stripOuterQuotes(value: string): string {
  const stripped = value.replace(/^"+|"+$/g, "").trim();
  return stripped || value;
}

function splitAddressList(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let angleDepth = 0;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      current += char;
      continue;
    }
    if (!inQuote && char === "<") angleDepth++;
    if (!inQuote && char === ">" && angleDepth > 0) angleDepth--;
    if (!inQuote && angleDepth === 0 && char === ",") {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

function buildParticipants(args: {
  readonly from: ParsedAddress;
  readonly to: ReturnType<typeof parseAddressList>;
  readonly cc: ReturnType<typeof parseAddressList>;
  readonly bcc: ReturnType<typeof parseAddressList>;
  readonly listId: string | null;
}): {
  readonly items: ObservationParticipant[];
  readonly recipientCount: number;
  readonly droppedAddressCount: number;
} {
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

function buildEvidenceHash(value: JsonValue): string {
  return `sha256:${sha256(stableStringify(value))}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
